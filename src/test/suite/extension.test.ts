// End-to-end test inside a real editor window. Uses real clicks and key presses
// (via CDP) and the real Claude Code CLI, and saves screenshots of each step.
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { Cdp } from "./cdp";
import type { InlineExplainApi } from "../../extension";

const shotsDir = process.env.SCREENSHOT_DIR || path.resolve(__dirname, "../../../test-screenshots");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function rectOf(cdp: Cdp, selector: string, text?: string): Promise<{ x: number; y: number } | undefined> {
  return cdp.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(e => e.offsetParent !== null && (${JSON.stringify(text ?? "")} === "" || e.textContent.includes(${JSON.stringify(text ?? "")})));
    const r = els[0]?.getBoundingClientRect();
    return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : undefined;
  })()`);
}

const inCommentEditor = (cdp: Cdp) => cdp.eval<boolean>(`!!document.activeElement?.closest(".review-widget")`);

describe("Claude Inline Explain (real editor + real Claude Code)", () => {
  let api: InlineExplainApi;
  let cdp: Cdp;
  let editor: vscode.TextEditor;
  const cfg = () => vscode.workspace.getConfiguration("claudeInlineExplain");

  before(async () => {
    const ext = vscode.extensions.getExtension<InlineExplainApi>("draac0.claude-inline-explain");
    assert.ok(ext, "extension not found");
    api = await ext.activate();
    await cfg().update("model", "sonnet", vscode.ConfigurationTarget.Global);
    await cfg().update("showInlineHint", true, vscode.ConfigurationTarget.Global);
    cdp = await Cdp.connect(process.env.CDP_PORT || "9339");
    // A fresh Cursor profile shows a login overlay; hide it in this throwaway test profile.
    await cdp.eval(`(() => { const s = document.createElement("style"); s.textContent = ".onboarding-v2-overlay{display:none!important}"; document.head.appendChild(s); })()`);
    const folder = vscode.workspace.workspaceFolders![0].uri;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, "planning.ts"));
    editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});
    await sleep(1500);
  });

  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      const name = "FAILED-" + this.currentTest.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
      await cdp.screenshot(shotsDir, name).catch(() => {});
      const dom = await cdp.eval(`(() => { const w = document.querySelector(".review-widget"); return { widget: !!w, active: document.activeElement?.className?.toString().slice(0, 80), html: w?.outerHTML.slice(0, 1500) }; })()`).catch(() => undefined);
      console.log("   DOM:", JSON.stringify(dom));
    }
  });

  after(() => cdp?.close());

  // Editor handles get recreated as focus moves between the editor and the popover.
  const select = async (a: number, b: number, c: number, d: number) => {
    editor = await vscode.window.showTextDocument(editor.document, { preserveFocus: false });
    editor.selection = new vscode.Selection(a, b, c, d);
  };

  it("shows an Explain CodeLens, inline hint and code action when code is selected", async () => {
    // Select the handleSave function (lines 9-23).
    editor.selection = new vscode.Selection(8, 2, 22, 4);
    await sleep(900);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", editor.document.uri);
    const lens = lenses.find((l) => l.command?.title.includes("Explain"));
    assert.ok(lens, "Explain CodeLens missing");
    assert.strictEqual(lens.range.start.line, 8);

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider", editor.document.uri, editor.selection
    );
    assert.ok(actions.some((a) => a.title.includes("Explain with Claude")), "code action missing");

    await waitFor("CodeLens rendered", () => rectOf(cdp, ".codelens-decoration a", "Explain"));
    await cdp.screenshot(shotsDir, "1-selection-explain-button");
  });

  it("clicking Explain opens a popover above the selection with the input focused", async () => {
    const pos = await waitFor("CodeLens rendered", () => rectOf(cdp, ".codelens-decoration a", "Explain"));
    await cdp.click(pos.x, pos.y);
    const session = await waitFor("session", () => api.session);
    assert.strictEqual(session.ctx.startLine, 9);
    assert.strictEqual(session.ctx.endLine, 23);
    assert.ok(session.ctx.selection.startsWith("const handleSave"));
    await waitFor("popover rendered", () => rectOf(cdp, ".review-widget"));
    await waitFor("input focused", () => inCommentEditor(cdp));
    await cdp.screenshot(shotsDir, "2-popover-open");
  });

  it("typing a question and pressing Enter streams Claude's answer into the popover", async () => {
    const session = api.session!;
    const question = "why is the catch block empty?";
    await cdp.typeText(question);
    await sleep(200);
    const done = new Promise<any>((r) => session.done.event(r));
    await cdp.press("Enter");
    await waitFor("streaming started", () => session.turns[0]?.status === "streaming" || session.turns[0]?.status === "done", 60000);
    await cdp.screenshot(shotsDir, "3-streaming");
    const turn = await done;
    assert.strictEqual(turn.display, question, "Enter should submit the typed text (not insert a newline)");
    assert.strictEqual(turn.status, "done", turn.error);
    assert.match(turn.answer, /interceptor|toast/i);
    assert.strictEqual(turn.model, "sonnet");
    assert.strictEqual(session.thread?.range?.start.line, 7, "popover should anchor on the line above the selection");
    await waitFor("answer rendered", () => cdp.eval<boolean>(`[...document.querySelectorAll(".review-widget .comment-body")].some(e => /interceptor|toast/i.test(e.textContent))`));
    await cdp.screenshot(shotsDir, "4-answer");
  });

  it("supports a follow-up question, using the selected model from settings", async () => {
    await cfg().update("model", "haiku", vscode.ConfigurationTarget.Global);
    assert.strictEqual(api.currentModel(), "haiku");
    const session = api.session!;
    const reply = await waitFor("follow-up box", () => rectOf(cdp, ".review-widget .review-thread-reply-button"));
    await cdp.click(reply.x, reply.y);
    await waitFor("follow-up focused", () => inCommentEditor(cdp));
    await cdp.typeText("Give a one-line summary.");
    const done = new Promise<any>((r) => session.done.event(r));
    await cdp.press("Enter");
    const turn = await done;
    assert.strictEqual(turn.status, "done", turn.error);
    assert.strictEqual(turn.model, "haiku");
    assert.strictEqual(session.turns.length, 2);
    assert.ok(turn.answer.length > 10);
    await sleep(300);
    await cdp.screenshot(shotsDir, "5-follow-up");
  });

  it("an empty prompt explains the code; Escape closes the popover", async () => {
    await cfg().update("model", "sonnet", vscode.ConfigurationTarget.Global);
    await select(11, 0, 14, 8);
    await vscode.commands.executeCommand("claudeInlineExplain.explain");
    const session = await waitFor("new session", () => (api.session && api.session.ctx.startLine === 12 ? api.session : undefined));
    await waitFor("input focused", () => inCommentEditor(cdp));
    const done = new Promise<any>((r) => session.done.event(r));
    await cdp.press("Enter");
    const turn = await done;
    assert.strictEqual(turn.display, "explain");
    assert.strictEqual(turn.question, "Explain what this code does.");
    assert.strictEqual(turn.status, "done", turn.error);
    assert.match(turn.answer, /setQueryData|cache/i);
    await sleep(300);
    await cdp.screenshot(shotsDir, "6-empty-prompt-explain");

    const reply = await waitFor("follow-up box", () => rectOf(cdp, ".review-widget .review-thread-reply-button"));
    await cdp.click(reply.x, reply.y);
    await waitFor("follow-up focused", () => inCommentEditor(cdp));
    await cdp.press("Escape");
    await waitFor("popover closed", () => !api.session);
    await waitFor("widget removed", async () => !(await rectOf(cdp, ".review-widget")));
  });

  it("re-opening replaces an unused popover, and its Close button removes it", async () => {
    const widgets = () => cdp.eval<number>(`[...document.querySelectorAll(".review-widget")].filter(e => e.offsetParent !== null).length`);
    await select(8, 2, 22, 4);
    await api.open();
    await waitFor("popover", async () => (await widgets()) === 1);
    await select(11, 0, 14, 8);
    await api.open();
    await waitFor("input focused", () => inCommentEditor(cdp));
    await sleep(500);
    assert.strictEqual(await widgets(), 1, "old empty popover should be gone");
    assert.strictEqual(api.session?.ctx.startLine, 12);
    const close = await waitFor("Close button", () => rectOf(cdp, ".review-widget .monaco-button", "Close"));
    await cdp.click(close.x, close.y);
    await waitFor("popover closed", async () => (await widgets()) === 0 && !api.session);
    assert.ok(!editor.selection.isEmpty || vscode.window.activeTextEditor?.selection.isEmpty === false, "selection kept");
  });

  it("the Stop button in the popover title cancels a running answer", async () => {
    await select(8, 2, 22, 4);
    const session = (await api.open())!;
    await waitFor("input focused", () => inCommentEditor(cdp));
    await cdp.typeText("Walk through this line by line in great detail.");
    await cdp.press("Enter");
    await waitFor("streaming", () => session.turns[0]?.status === "streaming", 60000);
    const stop = await waitFor("stop button", () => rectOf(cdp, ".review-widget .codicon-debug-stop"));
    const done = new Promise<any>((r) => session.done.event(r));
    await cdp.click(stop.x, stop.y);
    const turn = await done;
    assert.strictEqual(turn.status, "stopped");
    await vscode.commands.executeCommand("claudeInlineExplain.close");
    assert.ok(!api.session);
  });
});
