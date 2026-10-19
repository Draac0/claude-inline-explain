// The inline popover: a webview drawn inside the editor between code lines
// (the proposed "editorInsets" API), plus the conversation it shows.

import * as vscode from "vscode";
import { runClaude, ClaudeError } from "./claude";
import { buildPrompt, CodeContext, Turn } from "./prompt";

export type TurnStatus = "pending" | "streaming" | "done" | "error" | "stopped";

export interface TurnView {
  question: string;
  display: string;
  answer: string;
  status: TurnStatus;
  error?: string;
  model: string;
  durationMs?: number;
}

export interface PopoverHost {
  extensionUri: vscode.Uri;
  log(line: string): void;
  currentModel(): string;
  systemPrompt(): string;
  runOptions(): { effort?: string; claudePath?: string; readOnlyTools: boolean; loadCustomizations: boolean; timeoutMs: number };
  style(): { fontSize: number; fontFamily: string };
  maxHeightRatio(): number;
  // Fixed popover height as a fraction of the visible editor, or undefined for "auto" (fit the answer).
  heightSetting(): { label: string; ratio?: number };
  selectHeight(): Promise<void>;
  // Catch editor keystrokes while the popover has no focused input.
  guardTyping(session: ExplainSession): void;
  selectModel(): Promise<void>;
  onClosed(session: ExplainSession, byUser: boolean): void;
}

// Thrown when the editor won't create insets: the proposal isn't enabled for
// this extension, or the editor no longer ships the API.
export class InsetUnavailableError extends Error {}

const MIN_LINES = 4;

function editorLineHeightPx(): number {
  const c = vscode.workspace.getConfiguration("editor");
  const fontSize = c.get<number>("fontSize", 14);
  const lineHeight = c.get<number>("lineHeight", 0);
  if (lineHeight === 0) return Math.round(fontSize * (process.platform === "darwin" ? 1.5 : 1.35));
  if (lineHeight < 8) return Math.round(fontSize * lineHeight);
  return lineHeight;
}

export class ExplainSession {
  readonly turns: TurnView[] = [];
  readonly done = new vscode.EventEmitter<TurnView>();
  // Reported by the webview; used by tests and to keep focus across resizes.
  inputFocused = false;
  draft = "";
  heightLines = 0;

  private inset?: vscode.WebviewEditorInset;
  private abort?: AbortController;
  private closed = false;
  private pxPerLine = editorLineHeightPx();
  private contentPx = 0;
  private fitTimer?: NodeJS.Timeout;
  private pendingDraft = "";
  private focusOnReady = true;
  private rectWaiters = new Map<number, (r: any) => void>();
  private nextRectId = 1;
  private turnTimer?: NodeJS.Timeout;
  private dirtyTurns = new Set<number>();

  constructor(
    readonly editor: vscode.TextEditor,
    readonly selection: vscode.Range,
    readonly anchorLine: number, // the inset sits after this (0-based) line; -1 = top of file
    readonly ctx: CodeContext,
    readonly cwd: string,
    private readonly host: PopoverHost
  ) {}

  get uri(): vscode.Uri {
    return this.editor.document.uri;
  }

  get busy(): boolean {
    return !!this.abort;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  // Throws InsetUnavailableError if the editor can't draw the popover.
  open(): void {
    const est = 34 + 46 + 14 + 6; // header + one-line input + hint + padding, in px
    this.createInset(Math.max(MIN_LINES, Math.ceil(est / this.pxPerLine)), true);
  }

  // Text typed in the editor before the webview took focus.
  addEarlyKeys(text: string): void {
    if (this.inset && this.readyOnce) this.inset.webview.postMessage({ t: "draft", text });
    else this.pendingDraft += text;
  }

  focus(): void {
    this.inset?.webview.postMessage({ t: "focus" });
  }

  private readyOnce = false;
  private rebuilt = false;

  private createInset(lines: number, focus: boolean): void {
    const old = this.inset;
    this.inset = undefined;
    old?.dispose();

    const media = vscode.Uri.joinPath(this.host.extensionUri, "media");
    let inset: vscode.WebviewEditorInset;
    try {
      if (typeof vscode.window.createWebviewTextEditorInset !== "function") {
        throw new InsetUnavailableError("createWebviewTextEditorInset is not available in this editor");
      }
      inset = vscode.window.createWebviewTextEditorInset(this.editor, this.anchorLine, lines, {
        enableScripts: true,
        localResourceRoots: [media],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw e instanceof InsetUnavailableError || /proposal|editorInsets|not a function/i.test(msg) ? new InsetUnavailableError(msg) : e;
    }
    this.inset = inset;
    this.heightLines = lines;
    this.readyOnce = false;
    this.focusOnReady = focus;
    inset.onDidDispose(() => {
      if (this.inset === inset) this.close("editor closed the popover");
    });
    inset.webview.onDidReceiveMessage((m) => {
      if (this.inset === inset) void this.onMessage(m);
    });
    inset.webview.html = this.html(inset.webview, media);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const uri = (p: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, p)).toString();
    return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri("popover.css")}">
</head><body>
<div class="pop">
  <header>
    <span class="title">Claude</span>
    <button id="model" title="Change model"></button>
    <button id="height" title="Change popover height"></button>
    <span class="where" id="where"></span>
    <span class="spacer"></span>
    <button id="stop" title="Stop" hidden><span class="icon">■</span> Stop</button>
    <button id="close" title="Close (Esc)"><span class="icon">×</span></button>
  </header>
  <main id="turns"></main>
  <footer>
    <textarea id="q" rows="1" placeholder="Ask a question about the selected code…"></textarea>
    <div class="hint">Enter to send · Shift+Enter for a new line · Enter on empty explains · Esc to close</div>
  </footer>
</div>
<script nonce="${nonce}" src="${uri("vendor/markdown-it.min.js")}"></script>
<script nonce="${nonce}" src="${uri("popover.js")}"></script>
</body></html>`;
  }

  private where(): string {
    const { startLine, endLine, relativePath } = this.ctx;
    const file = relativePath.split(/[\\/]/).pop();
    return `${file} · ${startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`}`;
  }

  // fill: the card takes the inset's full height (streaming, or a fixed size).
  // Otherwise it shrinks to its content, and the inset itself shrinks later,
  // once the user isn't typing in it (see scheduleFit).
  private fill(): boolean {
    return this.busy || !!this.host.heightSetting().ratio;
  }

  private postHeader(): void {
    this.inset?.webview.postMessage({ t: "header", busy: this.busy, model: this.host.currentModel(), where: this.where(), height: this.host.heightSetting().label, fill: this.fill() });
  }

  refreshHeader(): void {
    this.postHeader();
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.t) {
      case "ready": {
        this.readyOnce = true;
        const draft = this.pendingDraft;
        this.pendingDraft = "";
        this.inset?.webview.postMessage({
          t: "init",
          state: { turns: this.turns, busy: this.busy, model: this.host.currentModel(), where: this.where(), height: this.host.heightSetting().label, fill: this.fill() },
          style: this.host.style(),
          draft: this.draftForInit(draft),
          focus: this.focusOnReady,
          rebuilt: this.rebuilt,
        });
        break;
      }
      case "focus":
        this.inputFocused = !!m.focused;
        this.host.log(`popover input ${m.focused ? "focused" : "blurred"}`);
        if (!this.inputFocused) this.scheduleFit();
        break;
      case "debug":
        this.host.log(`webview: ${m.text}`);
        break;
      case "draft":
        this.draft = String(m.text ?? "");
        break;
      case "ask":
        void this.ask(String(m.text ?? ""));
        break;
      case "close":
        this.close("closed by user");
        break;
      case "stop":
        this.stop();
        break;
      case "model":
        await this.host.selectModel();
        this.postHeader();
        this.focus();
        break;
      case "height":
        // The setting change applies the new height (applyHeight); the picker
        // took focus, so put it back in the popover afterwards.
        this.refocusAfterHeight = true;
        await this.host.selectHeight();
        this.postHeader();
        if (this.refocusAfterHeight) {
          this.refocusAfterHeight = false;
          this.focus();
        }
        break;
      case "copy": {
        const t = this.turns[m.index];
        if (t?.answer) {
          await vscode.env.clipboard.writeText(t.answer);
          vscode.window.setStatusBarMessage("Copied Claude's answer", 2000);
        }
        break;
      }
      case "link":
        if (typeof m.href === "string" && /^https?:/i.test(m.href)) void vscode.env.openExternal(vscode.Uri.parse(m.href));
        break;
      case "size":
        if (m.viewportPx > 0 && this.heightLines > 0) this.pxPerLine = m.viewportPx / this.heightLines;
        this.contentPx = m.contentPx;
        break;
      case "rects":
        this.rectWaiters.get(m.id)?.(m.rects);
        this.rectWaiters.delete(m.id);
        break;
    }
  }

  // On a rebuild the old webview's draft carries over; on first open, keys
  // captured before the webview loaded do.
  private carryDraft?: string;
  private draftForInit(early: string): string {
    if (this.carryDraft !== undefined) {
      const d = this.carryDraft;
      this.carryDraft = undefined;
      return d + early;
    }
    return early;
  }

  // Insets can't change height, so resizing rebuilds the webview with the same state.
  private resize(lines: number, forceFocus = false): void {
    if (this.closed || lines === this.heightLines) return;
    this.host.log(`resize popover ${this.heightLines} -> ${lines} lines (input focused: ${this.inputFocused})`);
    this.carryDraft = this.draft;
    const refocus = this.inputFocused || forceFocus;
    if (refocus) this.host.guardTyping(this);
    this.rebuilt = true;
    this.createInset(lines, refocus);
  }

  private visibleLines(): number {
    return this.editor.visibleRanges.reduce((n, r) => n + (r.end.line - r.start.line + 1), 0) || 40;
  }

  private maxLines(): number {
    return Math.max(10, Math.floor(this.visibleLines() * this.host.maxHeightRatio()));
  }

  // The height the popover should have while showing answers: the chosen fixed
  // size, or (auto) the maximum while streaming.
  private answerLines(): number {
    const ratio = this.host.heightSetting().ratio;
    return ratio ? Math.max(MIN_LINES + 2, Math.floor(this.visibleLines() * ratio)) : this.maxLines();
  }

  private fitLines(): number {
    if (this.host.heightSetting().ratio) return this.answerLines(); // fixed size: never shrink to fit
    return Math.min(this.maxLines(), Math.max(MIN_LINES, Math.ceil((this.contentPx + 4) / this.pxPerLine)));
  }

  // Called when the height setting changes. A popover without answers stays
  // compact; otherwise resize now, keeping the cursor in the popover.
  applyHeight(refocus: boolean): void {
    const rf = refocus || this.refocusAfterHeight;
    if (this.closed || !this.turns.length) return;
    clearTimeout(this.fitTimer);
    const want = this.busy ? this.answerLines() : this.fitLines();
    if (want === this.heightLines) return;
    this.refocusAfterHeight = false;
    this.resize(want, rf);
  }

  private refocusAfterHeight = false;

  // Shrink the inset to fit after an answer, but only while the user isn't in
  // the popover: a rebuild briefly has no input, and keys typed then are lost.
  // Until then the card itself shrinks to its content (see fill()).
  private scheduleFit(): void {
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => {
      if (this.busy || this.closed || this.inputFocused) return;
      const want = this.fitLines();
      if (Math.abs(want - this.heightLines) >= 2) this.resize(want);
    }, 300);
  }

  ask(text: string): Promise<void> {
    const question = text.trim() || vscode.workspace.getConfiguration("claudeInlineExplain").get<string>("defaultQuestion") || "Explain what this code does.";
    const display = text.trim() || "explain";
    this.draft = ""; // sent; don't carry it into the rebuilt popover
    this.stop();
    clearTimeout(this.fitTimer);

    const model = this.host.currentModel();
    const turn: TurnView = { question, display, answer: "", status: "pending", model };
    const history: Turn[] = this.turns.filter((t) => t.status === "done").map((t) => ({ question: t.question, answer: t.answer }));
    this.turns.push(turn);
    const index = this.turns.length - 1;

    const abort = new AbortController();
    this.abort = abort;
    // Grow now, while the user has just pressed Enter and isn't typing.
    const target = this.answerLines();
    if (this.heightLines < target || this.host.heightSetting().ratio) this.resize(target);
    this.postTurn(index, true);
    this.postHeader();

    const opts = this.host.runOptions();
    return runClaude({
      prompt: buildPrompt(this.ctx, history, question),
      systemPrompt: this.host.systemPrompt(),
      model,
      effort: opts.effort,
      cwd: this.cwd,
      claudePath: opts.claudePath,
      readOnlyTools: opts.readOnlyTools,
      loadCustomizations: opts.loadCustomizations,
      timeoutMs: opts.timeoutMs,
      signal: abort.signal,
      log: (l) => this.host.log(l),
      onText: (delta) => {
        turn.answer += delta;
        turn.status = "streaming";
        this.postTurn(index);
      },
    })
      .then(
        (result) => {
          turn.answer = result.text.trim() || turn.answer;
          turn.status = "done";
          turn.durationMs = result.durationMs;
          this.host.log(`answer done in ${result.durationMs ?? "?"}ms (${turn.answer.length} chars, model ${result.model})`);
        },
        (err: unknown) => {
          if (abort.signal.aborted) {
            turn.status = "stopped";
          } else {
            const e = err as ClaudeError;
            turn.status = "error";
            turn.error = e?.hint ? `${e.message}\n${e.hint}` : String(e?.message ?? err);
            this.host.log(`error: ${turn.error}`);
          }
        }
      )
      .finally(() => {
        if (this.abort === abort) this.abort = undefined;
        this.postTurn(index, true);
        this.postHeader();
        this.done.fire(turn);
        this.scheduleFit();
      });
  }

  // Streaming sends many small updates; batch them.
  private postTurn(index: number, now = false): void {
    this.dirtyTurns.add(index);
    if (now) {
      clearTimeout(this.turnTimer);
      this.turnTimer = undefined;
      this.flushTurns();
    } else if (!this.turnTimer) {
      this.turnTimer = setTimeout(() => {
        this.turnTimer = undefined;
        this.flushTurns();
      }, 50);
    }
  }

  private flushTurns(): void {
    for (const i of this.dirtyTurns) this.inset?.webview.postMessage({ t: "turn", index: i, turn: this.turns[i] });
    this.dirtyTurns.clear();
  }

  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.postHeader();
  }

  // Test helper: centres of the popover's controls, relative to the webview.
  requestRects(): Promise<Record<string, { x: number; y: number } | null>> {
    const id = this.nextRectId++;
    return new Promise((resolve) => {
      this.rectWaiters.set(id, resolve);
      this.inset?.webview.postMessage({ t: "rects", id });
    });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.host.log(`popover closed (${reason})`);
    this.abort?.abort();
    this.abort = undefined;
    clearTimeout(this.fitTimer);
    clearTimeout(this.turnTimer);
    const inset = this.inset;
    this.inset = undefined;
    inset?.dispose();
    this.done.dispose();
    this.host.onClosed(this, reason === "closed by user" && this.inputFocused);
  }
}
