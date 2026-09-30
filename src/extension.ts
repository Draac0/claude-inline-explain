import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { runClaude, ClaudeError, resetAuthCache } from "./claude";
import { buildPrompt, CodeContext, DEFAULT_SYSTEM_PROMPT, TOOLS_ADDENDUM, Turn, withInstructions } from "./prompt";

const CONTROLLER_ID = "claudeInlineExplain";
const CFG = "claudeInlineExplain";
const KEY_LABEL = process.platform === "darwin" ? "⌘⌥E" : "Ctrl+Alt+E";

let output: vscode.OutputChannel;
const log = (line: string) => {
  const stamped = `[${new Date().toISOString().slice(11, 23)}] ${line}`;
  output?.appendLine(stamped);
  if (process.env.CIE_DEBUG) console.log(`[claude-inline-explain] ${stamped}`);
};

function cfg() {
  return vscode.workspace.getConfiguration(CFG);
}

export function currentModel(): string {
  const c = cfg();
  return c.get<string>("customModel")?.trim() || c.get<string>("model") || "sonnet";
}

// ---------------------------------------------------------------------------
// Inline popover: one comment thread per explain session.

type TurnStatus = "pending" | "streaming" | "done" | "error" | "stopped";

class AnswerComment implements vscode.Comment {
  body: vscode.MarkdownString = new vscode.MarkdownString("");
  mode = vscode.CommentMode.Preview;
  contextValue = "claudeExplain.answer";
  label?: string;
  constructor(public author: vscode.CommentAuthorInformation, readonly turn: TurnView) {}
}

interface TurnView {
  question: string;
  display: string;
  answer: string;
  status: TurnStatus;
  error?: string;
  model: string;
  durationMs?: number;
  comment: AnswerComment;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+\-.!|<>~]/g, "\\$&");
}

class ExplainSession {
  readonly turns: TurnView[] = [];
  private abort?: AbortController;
  private renderTimer?: NodeJS.Timeout;
  private disposed = false;
  readonly done = new vscode.EventEmitter<TurnView>();

  thread?: vscode.CommentThread;

  constructor(
    readonly uri: vscode.Uri,
    readonly selection: vscode.Range,
    readonly anchor: vscode.Range,
    readonly ctx: CodeContext,
    readonly cwd: string,
    private readonly avatar: vscode.Uri
  ) {}

  attach(thread: vscode.CommentThread): void {
    if (this.thread === thread) return;
    this.thread?.dispose();
    this.thread = thread;
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.render();
  }

  get busy(): boolean {
    return !!this.abort;
  }

  ask(question: string, display: string): Promise<void> {
    this.stop();
    const model = currentModel();
    const turn: TurnView = { question, display, answer: "", status: "pending", model } as TurnView;
    turn.comment = new AnswerComment({ name: "Claude", iconPath: this.avatar }, turn);
    const history: Turn[] = this.turns.filter((t) => t.status === "done").map((t) => ({ question: t.question, answer: t.answer }));
    this.turns.push(turn);

    const abort = new AbortController();
    this.abort = abort;
    this.render();

    const c = cfg();
    const tools = c.get<boolean>("allowReadOnlyTools", false);
    const systemPrompt = withInstructions(
      (c.get<string>("systemPrompt")?.trim() || DEFAULT_SYSTEM_PROMPT) + (tools ? TOOLS_ADDENDUM : ""),
      c.get<string>("instructions") ?? ""
    );

    return runClaude({
      prompt: buildPrompt(this.ctx, history, question),
      systemPrompt,
      model,
      effort: c.get<string>("effort") || undefined,
      cwd: this.cwd,
      claudePath: c.get<string>("claudePath")?.trim() || undefined,
      readOnlyTools: tools,
      loadCustomizations: c.get<boolean>("loadClaudeCustomizations", false),
      timeoutMs: Math.max(10, c.get<number>("timeoutSeconds", 180)) * 1000,
      signal: abort.signal,
      log,
      onText: (delta) => {
        turn.answer += delta;
        turn.status = "streaming";
        this.scheduleRender();
      },
    }).then(
      (result) => {
        turn.answer = result.text.trim() || turn.answer;
        turn.status = "done";
        turn.durationMs = result.durationMs;
        log(`answer done in ${result.durationMs ?? "?"}ms (${turn.answer.length} chars, model ${result.model})`);
      },
      (err: unknown) => {
        if (abort.signal.aborted) {
          turn.status = "stopped";
        } else {
          turn.status = "error";
          const e = err as ClaudeError;
          turn.error = e.hint ? `${e.message}\n\n${e.hint}` : String(e?.message ?? err);
          log(`error: ${turn.error}`);
        }
      }
    ).finally(() => {
      if (this.abort === abort) this.abort = undefined;
      this.render();
      this.done.fire(turn);
    });
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  private scheduleRender(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 60);
  }

  render(): void {
    if (this.disposed || !this.thread) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    for (const t of this.turns) {
      const head = `*${escapeMarkdown(t.display)}*\n\n`;
      let body: string;
      switch (t.status) {
        case "pending":
          body = "_Thinking…_";
          break;
        case "streaming":
          body = t.answer + " ▍";
          break;
        case "done":
          body = t.answer || "_(empty answer)_";
          break;
        case "stopped":
          body = (t.answer ? t.answer + "\n\n" : "") + "_(stopped)_";
          break;
        case "error":
          body = (t.answer ? t.answer + "\n\n" : "") + `⚠️ ${escapeMarkdown(t.error ?? "Unknown error")}`;
          break;
      }
      t.comment.body = new vscode.MarkdownString(head + body);
      t.comment.label = t.durationMs ? `${t.model} · ${(t.durationMs / 1000).toFixed(1)}s` : t.model;
    }
    this.thread.comments = this.turns.map((t) => t.comment);
    // Only push header changes when they differ; every thread update re-renders the widget.
    const contextValue = this.busy ? "claudeExplain.busy" : "claudeExplain.idle";
    if (this.thread.contextValue !== contextValue) this.thread.contextValue = contextValue;
    const lines = this.ctx.startLine === this.ctx.endLine ? `line ${this.ctx.startLine}` : `lines ${this.ctx.startLine}–${this.ctx.endLine}`;
    const label = `Claude · ${currentModel()} · ${lines}${this.busy ? " · thinking…" : ""}`;
    if (this.thread.label !== label) this.thread.label = label;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    clearTimeout(this.renderTimer);
    this.thread?.dispose();
    this.done.dispose();
  }
}

// ---------------------------------------------------------------------------

class ExplainController implements vscode.Disposable {
  private readonly comments: vscode.CommentController;
  session?: ExplainSession;
  private readonly avatar: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  // The one line where a commenting range is offered (the popover's anchor), so
  // the built-in "Add Comment" can open a thread whose input is already focused.
  private armed?: { uri: string; line: number };
  private rangesServed?: (uri: string) => void;

  constructor(context: vscode.ExtensionContext) {
    this.avatar = vscode.Uri.joinPath(context.extensionUri, "media", "claude.svg");
    this.comments = vscode.comments.createCommentController(CONTROLLER_ID, "Claude Inline Explain");
    this.comments.options = {
      prompt: "Add a follow-up…",
      placeHolder: "Ask a quick question — Enter to send, Shift+Enter for a new line, empty = explain",
    };
    this.setRangeProvider();
    this.disposables.push(
      this.comments,
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (this.session && this.session.uri.toString() === doc.uri.toString()) this.closeSession();
      })
    );
  }

  async open(uri?: vscode.Uri, range?: vscode.Range): Promise<ExplainSession | undefined> {
    // While the popover input has focus there is no active text editor.
    const editor = vscode.window.activeTextEditor ?? lastEditor();
    let doc: vscode.TextDocument | undefined;
    if (uri instanceof vscode.Uri) {
      doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? (await vscode.workspace.openTextDocument(uri));
    } else {
      doc = editor?.document;
    }
    if (!doc) {
      log("explain: no editor to explain");
      vscode.window.showInformationMessage("Open a file and select some code to explain.");
      return;
    }
    let sel: vscode.Range | undefined = range instanceof vscode.Range ? range : undefined;
    if (!sel && editor && editor.document === doc) sel = editor.selection;
    if (!sel || sel.isEmpty) {
      // Nothing selected: fall back to the current line.
      const line = doc.lineAt((sel ?? editor?.selection ?? new vscode.Range(0, 0, 0, 0)).start.line);
      if (line.isEmptyOrWhitespace) {
        log("explain: empty selection on a blank line");
        vscode.window.showInformationMessage("Select some code to explain.");
        return;
      }
      sel = line.range;
    }
    // A selection ending at column 0 of the next line does not really include that line.
    if (sel.end.character === 0 && sel.end.line > sel.start.line) {
      sel = new vscode.Range(sel.start, doc.lineAt(sel.end.line - 1).range.end);
    }

    this.closeSession();
    if (vscode.window.activeTextEditor?.document !== doc) await vscode.window.showTextDocument(doc);

    const n = Math.max(0, cfg().get<number>("contextLines", 40));
    const beforeStart = new vscode.Position(Math.max(0, sel.start.line - n), 0);
    const afterEndLine = Math.min(doc.lineCount - 1, sel.end.line + n);
    const ctx: CodeContext = {
      relativePath: doc.uri.scheme === "file" || doc.uri.scheme === "vscode-remote" ? vscode.workspace.asRelativePath(doc.uri) : doc.fileName || doc.uri.toString(),
      languageId: doc.languageId,
      startLine: sel.start.line + 1,
      endLine: sel.end.line + 1,
      selection: doc.getText(sel),
      before: doc.getText(new vscode.Range(beforeStart, sel.start)),
      after: doc.getText(new vscode.Range(sel.end, doc.lineAt(afterEndLine).range.end)),
    };

    // Comment widgets render below their range's last line, so anchor on the
    // line above the selection to show the popover on top of it.
    const above = cfg().get<string>("popoverPosition", "above") === "above" && sel.start.line > 0;
    const anchorLine = above ? sel.start.line - 1 : sel.end.line;
    const anchor = new vscode.Range(anchorLine, 0, anchorLine, 0);

    const session = new ExplainSession(doc.uri, sel, anchor, ctx, workingDirFor(doc.uri), this.avatar);
    this.session = session;
    log(`opening popover for ${ctx.relativePath}:${ctx.startLine}-${ctx.endLine} (anchor line ${anchorLine + 1})`);

    const shown = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    shown?.revealRange(new vscode.Range(anchor.start, sel.start), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    lensEvents.fire();

    // Extension-created threads start with a collapsed input, and the API that
    // could focus it is a proposal Cursor blocks. A thread opened through the
    // built-in "Add Comment" starts expanded and focused, so offer a commenting
    // range on the anchor line and open the thread there.
    await this.arm(doc.uri, anchorLine);
    if (this.session !== session) return session;
    await vscode.commands.executeCommand("workbench.action.addComment", {
      range: { startLineNumber: anchorLine + 1, endLineNumber: anchorLine + 1, endColumn: 1 },
    });
    return session;
  }

  private setRangeProvider(): void {
    // Reassigning the provider makes the editor ask for ranges again.
    this.comments.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        const a = this.armed;
        const ranges = a && a.uri === doc.uri.toString() ? [new vscode.Range(a.line, 0, a.line, 0)] : [];
        if (ranges.length) queueMicrotask(() => this.rangesServed?.(doc.uri.toString()));
        return ranges;
      },
    };
  }

  private async arm(uri: vscode.Uri, line: number): Promise<void> {
    this.armed = { uri: uri.toString(), line };
    const served = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      this.rangesServed = (u) => {
        if (u !== uri.toString()) return;
        clearTimeout(timer);
        this.rangesServed = undefined;
        resolve();
      };
    });
    this.setRangeProvider();
    await served;
    await new Promise((r) => setTimeout(r, 60)); // let the editor apply the ranges
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = undefined;
    this.setRangeProvider();
  }

  submit(reply: vscode.CommentReply | undefined): Promise<void> | undefined {
    const session = this.sessionFor(reply?.thread);
    if (!session) {
      reply?.thread.dispose(); // a thread from an earlier session
      return;
    }
    const text = (reply?.text ?? "").trim();
    const question = text || cfg().get<string>("defaultQuestion") || "Explain what this code does.";
    return session.ask(question, text || "explain");
  }

  // Enter in an empty input. The built-in submit ignores empty input, so this
  // asks the default question itself.
  async explainFromEmptyInput(): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (!s.thread) {
      // Still the built-in template thread: collapsing an empty thread deletes it.
      await vscode.commands.executeCommand("workbench.action.hideComment");
      s.attach(this.comments.createCommentThread(s.uri, s.anchor, []));
      this.restoreSelection(s);
    }
    await s.ask(cfg().get<string>("defaultQuestion") || "Explain what this code does.", "explain");
  }

  // Collapsing a thread moves the editor selection onto the thread's line.
  private restoreSelection(s: ExplainSession): void {
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === s.uri.toString());
    if (ed) ed.selection = new vscode.Selection(s.selection.start, s.selection.end);
  }

  stop(arg?: vscode.CommentThread | vscode.CommentReply): void {
    this.sessionFor(arg)?.stop();
    this.session?.render();
  }

  closeSession(arg?: vscode.CommentThread | vscode.CommentReply, fromInput = false): void {
    const thread = arg && ("thread" in arg ? arg.thread : arg);
    const s = arg ? this.sessionFor(arg) : this.session;
    log(`close: arg=${arg ? "yes" : "no"} fromInput=${fromInput} session=${!!s} adopted=${!!s?.thread}`);
    if (s && !s.thread && !thread) {
      // The popover is still the built-in template thread, which we have no
      // handle to. Collapsing an empty thread deletes it. "hideComment" only
      // works from the focused input; otherwise collapse the editor's threads.
      void vscode.commands.executeCommand(fromInput ? "workbench.action.hideComment" : "workbench.action.collapseAllComments").then(
        () => this.restoreSelection(s),
        (e) => log(`could not close popover: ${e}`)
      );
    }
    if (thread && thread !== s?.thread) thread.dispose();
    if (!s) return;
    s.dispose();
    if (s === this.session) {
      this.session = undefined;
      this.disarm();
    }
    lensEvents.fire();
  }

  refreshLabels(): void {
    this.session?.render();
  }

  // Finds the session a thread belongs to. The first time the popover's
  // template thread reaches us (submit or a title button), it is adopted.
  private sessionFor(arg?: vscode.CommentThread | vscode.CommentReply): ExplainSession | undefined {
    const s = this.session;
    if (!arg || !s) return s;
    const thread = "thread" in arg ? arg.thread : arg;
    if (s.thread === thread) return s;
    if (!s.thread && thread.uri.toString() === s.uri.toString()) {
      s.attach(thread);
      return s;
    }
    return undefined;
  }

  dispose(): void {
    this.closeSession();
    this.disposables.forEach((d) => d.dispose());
  }
}

let lastActiveEditor: vscode.TextEditor | undefined;
function lastEditor(): vscode.TextEditor | undefined {
  return lastActiveEditor && vscode.window.visibleTextEditors.includes(lastActiveEditor) ? lastActiveEditor : undefined;
}

function workingDirFor(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (folder?.uri.scheme === "file") return folder.uri.fsPath;
  if (uri.scheme === "file") return path.dirname(uri.fsPath);
  return os.homedir();
}

// ---------------------------------------------------------------------------
// "✨ Explain" affordances that appear when code is selected.

const lensEvents = new vscode.EventEmitter<void>();
let stableSelection: { uri: string; range: vscode.Range } | undefined;
let controller: ExplainController;

class ExplainCodeLensProvider implements vscode.CodeLensProvider {
  onDidChangeCodeLenses = lensEvents.event;
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!cfg().get<boolean>("showCodeLens", true) || !stableSelection) return [];
    if (stableSelection.uri !== doc.uri.toString()) return [];
    const range = stableSelection.range;
    const s = controller.session;
    if (s && s.uri.toString() === doc.uri.toString() && s.selection.isEqual(range)) return [];
    const at = new vscode.Range(range.start.line, 0, range.start.line, 0);
    return [
      new vscode.CodeLens(at, {
        title: `$(sparkle) Explain  ${KEY_LABEL}`,
        tooltip: "Ask Claude about the selected code",
        command: "claudeInlineExplain.explain",
        arguments: [doc.uri, range],
      }),
    ];
  }
}

class ExplainCodeActionProvider implements vscode.CodeActionProvider {
  static readonly kind = vscode.CodeActionKind.QuickFix.append("claudeExplain");
  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
    if (range.isEmpty || !cfg().get<boolean>("showCodeAction", true)) return [];
    const action = new vscode.CodeAction("✨ Explain with Claude", ExplainCodeActionProvider.kind);
    action.command = { title: "Explain with Claude", command: "claudeInlineExplain.explain", arguments: [doc.uri, new vscode.Range(range.start, range.end)] };
    return [action];
  }
}

const hintDecoration = vscode.window.createTextEditorDecorationType({
  after: {
    contentText: `  ✨ Explain ${KEY_LABEL}`,
    color: new vscode.ThemeColor("editorCodeLens.foreground"),
    fontStyle: "italic",
    margin: "0 0 0 1.5em",
  },
  rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
});

function trackSelection(context: vscode.ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;

  const apply = (editor: vscode.TextEditor | undefined) => {
    const sel = editor?.selection;
    const next = editor && sel && !sel.isEmpty ? { uri: editor.document.uri.toString(), range: new vscode.Range(sel.start, sel.end) } : undefined;
    const changed = next?.uri !== stableSelection?.uri || !(next && stableSelection && next.range.isEqual(stableSelection.range));
    stableSelection = next;
    if (changed) lensEvents.fire();

    for (const e of vscode.window.visibleTextEditors) {
      if (e !== editor || !next || !cfg().get<boolean>("showInlineHint", false)) {
        e.setDecorations(hintDecoration, []);
        continue;
      }
      let endLine = next.range.end.line;
      if (next.range.end.character === 0 && endLine > next.range.start.line) endLine--;
      const eol = e.document.lineAt(endLine).range.end;
      e.setDecorations(hintDecoration, [new vscode.Range(eol, eol)]);
    }
  };

  lastActiveEditor = vscode.window.activeTextEditor;
  const onChange = (editor: vscode.TextEditor | undefined) => {
    clearTimeout(timer);
    const sel = editor?.selection;
    if (!editor || !sel || sel.isEmpty) {
      apply(editor); // hide right away when the selection is cleared
      return;
    }
    timer = setTimeout(() => apply(editor), Math.max(0, cfg().get<number>("selectionDebounceMs", 350)));
  };

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => onChange(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) lastActiveEditor = e;
      onChange(e);
    }),
    { dispose: () => clearTimeout(timer) }
  );
}

// ---------------------------------------------------------------------------

const MODEL_CHOICES: { id: string; detail: string }[] = [
  { id: "sonnet", detail: "Latest Sonnet: fast, recommended for explanations" },
  { id: "opus", detail: "Latest Opus: most capable, slower" },
  { id: "haiku", detail: "Latest Haiku: fastest" },
  { id: "fable", detail: "Latest Fable" },
  { id: "default", detail: "Whatever your Claude Code CLI is configured to use" },
];

async function selectModel(): Promise<void> {
  const current = currentModel();
  const items: (vscode.QuickPickItem & { id?: string })[] = MODEL_CHOICES.map((m) => ({
    label: m.id,
    detail: m.detail,
    id: m.id,
    description: m.id === current ? "current" : undefined,
  }));
  items.push({ label: "Custom model name…", detail: "Any value accepted by `claude --model`, such as claude-sonnet-5-5" });
  const pick = await vscode.window.showQuickPick(items, { title: "Claude Inline Explain: model", placeHolder: `Current: ${current}` });
  if (!pick) return;
  const c = cfg();
  const target = settingTarget("model");
  if (pick.id) {
    await c.update("model", pick.id, target);
    if (c.get<string>("customModel")) await c.update("customModel", "", settingTarget("customModel"));
  } else {
    const value = await vscode.window.showInputBox({ title: "Custom model", prompt: "Model name or alias passed to claude --model", value: c.get<string>("customModel") || "" });
    if (value === undefined) return;
    await c.update("customModel", value.trim(), settingTarget("customModel"));
  }
  vscode.window.setStatusBarMessage(`Claude Inline Explain: using ${currentModel()}`, 3000);
}

// Write where the value is currently defined so workspace overrides keep working.
function settingTarget(key: string): vscode.ConfigurationTarget {
  const info = cfg().inspect(key);
  if (info?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (info?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

export interface InlineExplainApi {
  readonly session: ExplainSession | undefined;
  open(uri?: vscode.Uri, range?: vscode.Range): Promise<ExplainSession | undefined>;
  currentModel(): string;
}

export function activate(context: vscode.ExtensionContext): InlineExplainApi {
  output = vscode.window.createOutputChannel("Claude Inline Explain");
  controller = new ExplainController(context);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "claudeInlineExplain.selectModel";
  const updateStatus = () => {
    status.text = `$(sparkle) ${currentModel()}`;
    status.tooltip = "Claude Inline Explain model (click to change)";
    cfg().get<boolean>("showStatusBar", true) ? status.show() : status.hide();
  };
  updateStatus();

  context.subscriptions.push(
    output,
    controller,
    status,
    lensEvents,
    hintDecoration,
    vscode.languages.registerCodeLensProvider({ pattern: "**" }, new ExplainCodeLensProvider()),
    vscode.languages.registerCodeActionsProvider({ pattern: "**" }, new ExplainCodeActionProvider(), {
      providedCodeActionKinds: [ExplainCodeActionProvider.kind],
    }),
    vscode.commands.registerCommand("claudeInlineExplain.explain", (uri?: vscode.Uri, range?: vscode.Range) => controller.open(uri, range)),
    // Don't return the answer promise: the editor clears and collapses the input
    // only after this command resolves, which would wipe a follow-up typed meanwhile.
    vscode.commands.registerCommand("claudeInlineExplain.submit", (reply: vscode.CommentReply) => {
      void controller.submit(reply);
    }),
    vscode.commands.registerCommand("claudeInlineExplain.stop", (arg?: vscode.CommentThread) => controller.stop(arg)),
    vscode.commands.registerCommand("claudeInlineExplain.close", (arg?: vscode.CommentThread | vscode.CommentReply) => controller.closeSession(arg, !arg)),
    vscode.commands.registerCommand("claudeInlineExplain.explainFromEmptyInput", () => controller.explainFromEmptyInput()),
    vscode.commands.registerCommand("claudeInlineExplain.copyAnswer", async (comment?: AnswerComment) => {
      const turn = comment?.turn ?? controller.session?.turns.at(-1);
      if (!turn?.answer) return;
      await vscode.env.clipboard.writeText(turn.answer);
      vscode.window.setStatusBarMessage("Copied Claude's answer", 2000);
    }),
    vscode.commands.registerCommand("claudeInlineExplain.selectModel", selectModel),
    vscode.commands.registerCommand("claudeInlineExplain.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`)
    ),
    vscode.commands.registerCommand("claudeInlineExplain.showLogs", () => output.show()),
    vscode.commands.registerCommand("claudeInlineExplain.editInstructions", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `${CFG}.instructions`)
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CFG)) return;
      if (e.affectsConfiguration(`${CFG}.claudePath`)) resetAuthCache();
      updateStatus();
      controller.refreshLabels();
      lensEvents.fire();
    })
  );
  trackSelection(context);
  log(`activated (model ${currentModel()})`);

  return {
    get session() {
      return controller.session;
    },
    open: (uri, range) => controller.open(uri, range),
    currentModel,
  };
}

export function deactivate(): void {}
