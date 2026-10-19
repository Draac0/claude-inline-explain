import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import { resetAuthCache } from "./claude";
import { CodeContext, DEFAULT_SYSTEM_PROMPT, TOOLS_ADDENDUM, withInstructions } from "./prompt";
import { ExplainSession, InsetUnavailableError, PopoverHost } from "./popover";
import * as argv from "./argv";

const CFG = "claudeInlineExplain";
const KEY_LABEL = process.platform === "darwin" ? "⌘K" : "Ctrl+Alt+E";
const README_TROUBLESHOOTING = "https://github.com/Draac0/claude-inline-explain#if-the-popover-stops-working-after-a-cursor-or-vs-code-update";

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

class ExplainController implements vscode.Disposable, PopoverHost {
  session?: ExplainSession;
  readonly extensionUri: vscode.Uri;
  private typeGuard?: vscode.Disposable;
  private typeGuardTimer?: NodeJS.Timeout;
  private typeGuardLimit?: NodeJS.Timeout;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
  }

  // PopoverHost ------------------------------------------------------------
  log = log;
  currentModel = currentModel;
  selectModel = selectModel;

  systemPrompt(): string {
    const c = cfg();
    const tools = c.get<boolean>("allowReadOnlyTools", false);
    return withInstructions((c.get<string>("systemPrompt")?.trim() || DEFAULT_SYSTEM_PROMPT) + (tools ? TOOLS_ADDENDUM : ""), c.get<string>("instructions") ?? "");
  }

  runOptions() {
    const c = cfg();
    return {
      effort: c.get<string>("effort") || undefined,
      claudePath: c.get<string>("claudePath")?.trim() || undefined,
      readOnlyTools: c.get<boolean>("allowReadOnlyTools", false),
      loadCustomizations: c.get<boolean>("loadClaudeCustomizations", false),
      timeoutMs: Math.max(10, c.get<number>("timeoutSeconds", 180)) * 1000,
    };
  }

  style() {
    const size = cfg().get<number>("fontSize", 0) || vscode.workspace.getConfiguration("editor").get<number>("fontSize", 14);
    return { fontSize: size, fontFamily: cfg().get<string>("fontFamily", "")?.trim() ?? "" };
  }

  heightSetting() {
    const id = cfg().get<string>("popoverHeight", "auto");
    const h = HEIGHTS.find((x) => x.id === id) ?? HEIGHTS[0];
    return { label: h.label, ratio: h.ratio };
  }

  selectHeight = selectHeight;

  maxHeightRatio(): number {
    return Math.min(0.95, Math.max(0.2, cfg().get<number>("maxHeight", 0.6)));
  }

  guardTyping(session: ExplainSession): void {
    this.startTypeGuard(session);
  }

  onClosed(s: ExplainSession, byUserWhileFocused: boolean): void {
    if (this.session !== s) return;
    this.session = undefined;
    this.endTypeGuard();
    void vscode.commands.executeCommand("setContext", "claudeInlineExplain.popoverVisible", false);
    lensEvents.fire();
    // Esc/× from inside the popover: give the keyboard back to the code. Not on
    // other closes, which would yank focus from wherever it is now.
    if (byUserWhileFocused && vscode.window.visibleTextEditors.includes(s.editor)) {
      void vscode.window.showTextDocument(s.editor.document, { viewColumn: s.editor.viewColumn, preserveFocus: false });
    }
  }

  // -----------------------------------------------------------------------

  async open(uri?: vscode.Uri, range?: vscode.Range): Promise<ExplainSession | undefined> {
    let editor = vscode.window.activeTextEditor ?? lastEditor();
    if (uri instanceof vscode.Uri && editor?.document.uri.toString() !== uri.toString()) {
      editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
      if (!editor) editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }
    if (!editor) {
      vscode.window.showInformationMessage("Open a file and select some code to explain.");
      return;
    }
    const doc = editor.document;
    let sel: vscode.Range = range instanceof vscode.Range ? range : editor.selection;
    if (sel.isEmpty) {
      // Nothing selected: explain the current line.
      const line = doc.lineAt(sel.start.line);
      if (line.isEmptyOrWhitespace) {
        vscode.window.showInformationMessage("Select some code to explain.");
        return;
      }
      sel = line.range;
    }
    sel = normalizeSelection(doc, sel);

    // ⌘K again on the same selection just puts the cursor back in the popover.
    const s = this.session;
    if (s?.isOpen && s.editor === editor && s.selection.isEqual(sel)) {
      s.focus();
      return s;
    }
    s?.close("replaced by a new popover");

    const n = Math.max(0, cfg().get<number>("contextLines", 40));
    const afterEndLine = Math.min(doc.lineCount - 1, sel.end.line + n);
    const ctx: CodeContext = {
      relativePath: doc.uri.scheme === "file" || doc.uri.scheme === "vscode-remote" ? vscode.workspace.asRelativePath(doc.uri) : doc.fileName || doc.uri.toString(),
      languageId: doc.languageId,
      startLine: sel.start.line + 1,
      endLine: sel.end.line + 1,
      selection: doc.getText(sel),
      before: doc.getText(new vscode.Range(new vscode.Position(Math.max(0, sel.start.line - n), 0), sel.start)),
      after: doc.getText(new vscode.Range(sel.end, doc.lineAt(afterEndLine).range.end)),
    };

    // The inset is drawn after `anchor` (0-based); -1 puts it above line 1.
    const above = cfg().get<string>("popoverPosition", "above") === "above";
    const anchor = above ? sel.start.line - 1 : sel.end.line;
    editor.revealRange(new vscode.Range(Math.max(0, anchor), 0, sel.start.line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const session = new ExplainSession(editor, sel, anchor, ctx, workingDirFor(doc.uri), this);
    this.startTypeGuard(session);
    try {
      session.open();
    } catch (e) {
      this.endTypeGuard();
      if (e instanceof InsetUnavailableError) {
        log(`inset API unavailable: ${e.message}`);
        void showInsetHelp(this.context, e.message);
        return;
      }
      throw e;
    }
    this.session = session;
    void vscode.commands.executeCommand("setContext", "claudeInlineExplain.popoverVisible", true);
    log(`opened popover for ${ctx.relativePath}:${ctx.startLine}-${ctx.endLine}`);
    lensEvents.fire();
    return session;
  }

  // Until the popover's webview loads and takes focus (~0.2s), keystrokes still
  // go to the code editor. Catch typed text for that moment and hand it to the
  // popover instead of letting it edit the file.
  private startTypeGuard(session: ExplainSession): void {
    this.endTypeGuard();
    try {
      this.typeGuard = vscode.commands.registerCommand("type", (args: { text?: string }) => {
        if (args?.text) session.addEarlyKeys(args.text);
      });
    } catch {
      return; // another extension (e.g. Vim) owns "type"; skip the guard
    }
    let sawBlur = !session.inputFocused;
    const poll = () => {
      if (!session.inputFocused) sawBlur = true;
      if (!session.isOpen || (sawBlur && session.inputFocused)) return this.endTypeGuard();
      this.typeGuardTimer = setTimeout(poll, 40);
    };
    poll();
    this.typeGuardLimit = setTimeout(() => this.endTypeGuard(), 3000);
  }

  private endTypeGuard(): void {
    clearTimeout(this.typeGuardTimer);
    clearTimeout(this.typeGuardLimit);
    this.typeGuard?.dispose();
    this.typeGuard = undefined;
  }

  close(): void {
    this.session?.close("closed by user");
  }

  stop(): void {
    this.session?.stop();
  }

  dispose(): void {
    this.session?.close("extension deactivated");
    this.endTypeGuard();
  }
}

// A selection ending at column 0 of the next line does not really include that line.
function normalizeSelection(doc: vscode.TextDocument, sel: vscode.Range): vscode.Range {
  if (sel.end.character === 0 && sel.end.line > sel.start.line) {
    return new vscode.Range(sel.start, doc.lineAt(sel.end.line - 1).range.end);
  }
  return sel;
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
// One-time setup: the popover uses the proposed "editorInsets" API, which the
// editor only allows for extensions listed under enable-proposed-api in argv.json.

function argvFile(): string {
  return argv.argvPath(vscode.env.appRoot);
}

// Cursor binds ⌘K to its own Quick Edit at a priority no extension keybinding
// can beat, so ⌘K (and Esc) have to be user keybindings. Appends them to the
// user's keybindings.json (opened through the editor, so profiles work and the
// edit can be undone). Returns true if anything was added.
const KEY_K = process.platform === "darwin" ? "cmd+k" : "ctrl+k";
const USER_KEYBINDINGS = [
  { key: KEY_K, command: "claudeInlineExplain.explain", when: "editorTextFocus && editorHasSelection" },
  {
    key: "escape",
    command: "claudeInlineExplain.close",
    when: "claudeInlineExplain.popoverVisible && editorTextFocus && !editorHasSelection && !editorHasMultipleSelections && !suggestWidgetVisible && !findWidgetVisible && !inSnippetMode && !parameterHintsVisible && !renameInputVisible && !inlineSuggestionVisible",
  },
];

async function addUserKeybindings(): Promise<boolean> {
  await vscode.commands.executeCommand("workbench.action.openGlobalKeybindingsFile");
  const ed = vscode.window.activeTextEditor;
  if (!ed || !/keybindings\.json$/i.test(ed.document.fileName)) {
    log("couldn't open keybindings.json");
    return false;
  }
  const text = ed.document.getText();
  let existing: any[] = [];
  try {
    existing = JSON.parse(argv.blankComments(text).replace(/,(\s*[\]}])/g, "$1") || "[]");
  } catch {
    vscode.window.showWarningMessage("Your keybindings.json has a syntax error, so ⌘K wasn't added. Fix it and run the setup again.");
    return false;
  }
  const missing = USER_KEYBINDINGS.filter((k) => !existing.some((e) => e?.key === k.key && e?.command === k.command));
  if (!missing.length) return false;

  const blanked = argv.blankComments(text);
  const close = blanked.lastIndexOf("]");
  if (close < 0) return false;
  let at = close;
  while (at > 0 && /\s/.test(blanked[at - 1])) at--;
  const needsComma = blanked[at - 1] !== "[" && blanked[at - 1] !== ",";
  const body = missing.map((k) => JSON.stringify(k, null, 4).replace(/^/gm, "    ")).join(",\n");
  const insert = `${needsComma ? "," : ""}\n    // Claude Inline Explain: ${KEY_K} explains the selection; Esc closes its popover.\n${body}\n`;
  const pos = ed.document.positionAt(at);
  await ed.edit((eb) => eb.insert(pos, insert));
  await ed.document.save();
  log(`added ${missing.length} keybinding(s) to ${ed.document.fileName}`);
  return true;
}

async function enableInlinePopover(context: vscode.ExtensionContext): Promise<void> {
  const file = argvFile();
  const id = context.extension.id;
  try {
    const changed = argv.enable(file, id);
    log(changed ? `added ${id} to ${argv.ARGV_KEY} in ${file}` : `${id} already in ${file}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Couldn't update ${file}: ${e instanceof Error ? e.message : e}`);
    return;
  }
  await addUserKeybindings();
  const appName = vscode.env.appName;
  const pick = await vscode.window.showInformationMessage(
    `Claude Inline Explain is set up in ${file}. Quit and reopen ${appName} to turn the popover on (reloading the window isn't enough).`,
    `Quit ${appName}`,
    "Later"
  );
  if (pick?.startsWith("Quit")) void vscode.commands.executeCommand("workbench.action.quit");
}

async function showInsetHelp(context: vscode.ExtensionContext, detail: string): Promise<void> {
  const file = argvFile();
  const id = context.extension.id;
  if (!argv.isEnabled(file, id)) {
    const pick = await vscode.window.showWarningMessage(
      `Claude Inline Explain needs one-time setup to draw its popover: allow it to use the editor's inline webview API in ${file}, then restart ${vscode.env.appName}.`,
      "Set up now",
      "How it works"
    );
    if (pick === "Set up now") await enableInlinePopover(context);
    if (pick === "How it works") void vscode.env.openExternal(vscode.Uri.parse(README_TROUBLESHOOTING));
    return;
  }
  const pick = await vscode.window.showErrorMessage(
    `Claude Inline Explain can't draw its popover even though ${file} enables it. Either ${vscode.env.appName} hasn't been fully restarted since, or an update changed or removed the API it uses. (${detail})`,
    "Troubleshooting",
    "Show logs"
  );
  if (pick === "Troubleshooting") void vscode.env.openExternal(vscode.Uri.parse(README_TROUBLESHOOTING));
  if (pick === "Show logs") output.show();
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
    if (s?.isOpen && s.uri.toString() === doc.uri.toString() && s.selection.isEqual(normalizeSelection(doc, range))) return [];
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
      const end = normalizeSelection(e.document, next.range).end;
      const eol = e.document.lineAt(end.line).range.end;
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

const HEIGHTS: { id: string; label: string; ratio?: number; detail: string }[] = [
  { id: "auto", label: "Auto", detail: "Fit the answer, up to claudeInlineExplain.maxHeight of the editor" },
  { id: "small", label: "Small", ratio: 0.25, detail: "About a quarter of the visible editor" },
  { id: "medium", label: "Medium", ratio: 0.4, detail: "About 40% of the visible editor" },
  { id: "large", label: "Large", ratio: 0.6, detail: "About 60% of the visible editor" },
  { id: "xlarge", label: "Extra large", ratio: 0.8, detail: "About 80% of the visible editor" },
];

async function selectHeight(): Promise<void> {
  const current = cfg().get<string>("popoverHeight", "auto");
  const pick = await vscode.window.showQuickPick(
    HEIGHTS.map((h) => ({ label: h.label, detail: h.detail, id: h.id, description: h.id === current ? "current" : undefined })),
    { title: "Claude Inline Explain: popover height", placeHolder: "Height of the popover while it shows answers" }
  );
  if (!pick) return;
  await cfg().update("popoverHeight", pick.id, settingTarget("popoverHeight"));
}

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
  if (pick.id) {
    await c.update("model", pick.id, settingTarget("model"));
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
    vscode.commands.registerCommand("claudeInlineExplain.close", () => controller.close()),
    vscode.commands.registerCommand("claudeInlineExplain.stop", () => controller.stop()),
    vscode.commands.registerCommand("claudeInlineExplain.selectModel", async () => {
      await selectModel();
      controller.session?.refreshHeader();
    }),
    vscode.commands.registerCommand("claudeInlineExplain.selectHeight", () => selectHeight()),
    vscode.commands.registerCommand("claudeInlineExplain.enableInlinePopover", () => enableInlinePopover(context)),
    vscode.commands.registerCommand("claudeInlineExplain.addKeybindings", () => addUserKeybindings()),
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
      controller.session?.refreshHeader();
      if (e.affectsConfiguration(`${CFG}.popoverHeight`) || e.affectsConfiguration(`${CFG}.maxHeight`)) {
        controller.session?.applyHeight(!!controller.session?.inputFocused);
      }
      lensEvents.fire();
    })
  );
  trackSelection(context);
  log(`activated (model ${currentModel()})`);

  // Remind once per session if the one-time setup hasn't been done.
  if (!argv.isEnabled(argvFile(), context.extension.id) && !process.env.CIE_DEBUG) {
    void showInsetHelp(context, "not set up yet");
  }

  return {
    get session() {
      return controller.session;
    },
    open: (uri, range) => controller.open(uri, range),
    currentModel,
  };
}

export function deactivate(): void {}
