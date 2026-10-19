// End-to-end tests inside a real editor window: real key presses and clicks
// (via CDP), the real inline popover (editor inset), and the real Claude Code CLI.
import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import { Cdp } from "./cdp";
import type { InlineExplainApi } from "../../extension";
import type { ExplainSession, TurnView } from "../../popover";

const shotsDir = process.env.SCREENSHOT_DIR || path.resolve(__dirname, "../../../test-screenshots");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("Claude Inline Explain (real editor, inline popover, real Claude Code)", () => {
  let api: InlineExplainApi;
  let cdp: Cdp;
  let editor: vscode.TextEditor;
  let original: string;
  const cfg = () => vscode.workspace.getConfiguration("claudeInlineExplain");
  const folder = () => vscode.workspace.workspaceFolders![0].uri;

  // Editor handles get recreated as focus moves around, so always fetch a live one.
  const show = async (file = "planning.ts") => {
    editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder(), file)), { preserveFocus: false });
    return editor;
  };
  // Click a line of code, as a person would, so the keyboard is in the editor
  // (focusing an editor by API doesn't take focus away from a webview).
  const clickCode = async () => {
    await cdp.front();
    const p = await cdp.eval<{ x: number; y: number } | null>(`(() => {
      const lines = [...document.querySelectorAll(".editor-group-container .monaco-editor .margin-view-overlays .line-numbers")].filter(l => l.offsetParent && l.getBoundingClientRect().height > 0);
      const l = lines[Math.floor(lines.length / 2)]; if (!l) return null; // middle: away from edges and resize handles
      const r = l.getBoundingClientRect(); return { x: r.right - 6, y: r.y + r.height / 2 }; // on the number, not the breakpoint gutter
    })()`);
    if (p) {
      const hit = await cdp.eval<string>(`(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); return e ? e.tagName + "." + String(e.className).slice(0, 50) : "none"; })()`);
      await cdp.click(p.x, p.y);
      await sleep(100);
      const active = await cdp.eval<string>(`document.activeElement ? document.activeElement.tagName + "." + String(document.activeElement.className).slice(0, 50) : "none"`);
      if (!/inputarea/.test(active)) console.log(`   clickCode at ${Math.round(p.x)},${Math.round(p.y)} hit=${hit} -> active=${active}`);
    }
  };
  const select = async (a: number, b: number, c: number, d: number, file?: string) => {
    await show(file ?? path.basename(editor?.document.fileName ?? "planning.ts"));
    await clickCode();
    editor = vscode.window.activeTextEditor ?? editor;
    editor.selection = new vscode.Selection(a, b, c, d);
    await sleep(150); // let the "has selection" context settle, like a person would
  };
  const cmdK = () => cdp.chord("k", "KeyK", 75, 4);
  const session = () => api.session;
  const focused = (s?: ExplainSession) => !!(s ?? api.session)?.inputFocused;
  // Other apps on the desktop can take the OS focus during long waits; the
  // popover keeps its focus inside the window, so bring the window back first.
  const waitFocused = async (s: ExplainSession, what = "input focused", ms = 6000) => {
    await cdp.front();
    return waitFor(what, () => focused(s), ms);
  };
  const nextDone = (s: ExplainSession) => new Promise<TurnView>((r) => s.done.event(r));

  // The popover's webview is an iframe over the editor. Returns its rect in page coordinates.
  const insetFrames = () =>
    cdp.eval<{ x: number; y: number; w: number; h: number }[]>(`[...document.querySelectorAll("iframe.webview")]
      .map(f => f.getBoundingClientRect()).filter(r => r.width > 50 && r.height > 20)
      .map(r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))`);

  async function clickControl(s: ExplainSession, name: "close" | "stop" | "model" | "height" | "copy" | "input"): Promise<void> {
    const rects = await s.requestRects();
    const r = rects[name];
    assert.ok(r, `${name} control not visible`);
    const frames = await insetFrames();
    assert.strictEqual(frames.length, 1, `expected one popover frame, found ${frames.length}`);
    await cdp.click(frames[0].x + r.x, frames[0].y + r.y);
  }

  before(async () => {
    const ext = vscode.extensions.getExtension<InlineExplainApi>("draac0.claude-inline-explain");
    assert.ok(ext, "extension not found");
    api = await ext.activate();
    await cfg().update("model", "sonnet", vscode.ConfigurationTarget.Global);
    cdp = await Cdp.connect(process.env.CDP_PORT || "9339");
    // A fresh Cursor profile shows a login overlay; hide it in this throwaway profile.
    await cdp.eval(`(() => { const s = document.createElement("style"); s.textContent = ".onboarding-v2-overlay{display:none!important}"; document.head.appendChild(s); })()`);
    // Focus trace for diagnosing failures.
    await cdp.eval(`(() => { window.__flog = []; const d = e => e ? e.tagName + "." + String(e.className).slice(0, 40) : "null";
      const add = (x) => { __flog.push((performance.now()|0) + " " + x); if (__flog.length > 60) __flog.shift(); };
      document.addEventListener("focusin", e => add("in " + d(e.target)), true);
      document.addEventListener("focusout", e => add("out " + d(e.target)), true);
      document.addEventListener("mousedown", e => add("mousedown " + d(e.target)), true);
      window.addEventListener("blur", () => add("WINDOW blur"));
      window.addEventListener("focus", () => add("WINDOW focus")); })()`);
    // What the one-time setup does for ⌘K/Esc; without it Cursor's Quick Edit owns ⌘K.
    assert.strictEqual(await vscode.commands.executeCommand("claudeInlineExplain.addKeybindings"), true, "keybindings added");
    assert.strictEqual(await vscode.commands.executeCommand("claudeInlineExplain.addKeybindings"), false, "second run is a no-op");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await sleep(500);
    await show();
    original = editor.document.getText();
    for (const c of ["workbench.action.closeSidebar", "workbench.action.closePanel", "workbench.action.closeAuxiliaryBar"]) {
      await vscode.commands.executeCommand(c).then(undefined, () => {});
    }
    await sleep(1500);
  });

  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      const name = "FAILED-" + this.currentTest.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
      await cdp.screenshot(shotsDir, name).catch(() => {});
      const trace = await cdp.eval<string[]>(`window.__flog || []`).catch(() => []);
      console.log("   focus trace (ms, page time):\n      " + trace.slice(-25).join("\n      ") + `\n      now ${await cdp.eval("performance.now()|0")}`);
    }
    // No test may ever change the file.
    const doc = (await show()).document;
    assert.strictEqual(doc.getText(), original, "the code file was modified");
    assert.ok(!doc.isDirty, "the code file is dirty");
    if (api.session) {
      api.session.close("test cleanup");
      await sleep(300);
    }
  });

  after(() => cdp?.close());

  it("shows an Explain CodeLens and code action when code is selected", async () => {
    await select(8, 2, 22, 4);
    await sleep(800);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", editor.document.uri);
    const lens = lenses.find((l) => l.command?.title.includes("Explain"));
    assert.ok(lens, "Explain CodeLens missing");
    assert.strictEqual(lens.range.start.line, 8);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", editor.document.uri, editor.selection);
    assert.ok(actions.some((a) => a.title.includes("Explain with Claude")), "code action missing");
    await cdp.screenshot(shotsDir, "1-selection");
  });

  it("⌘K opens the inline popover above the selection with the input focused", async () => {
    await select(8, 2, 22, 4);
    await cmdK();
    const s = await waitFor("popover", session);
    assert.strictEqual(s.anchorLine, 7, "popover sits right above the selection");
    await waitFocused(s, "input focused", 6000);
    assert.strictEqual((await insetFrames()).length, 1);
    await cdp.screenshot(shotsDir, "2-popover-open");
  });

  it("typed text goes into the popover; Enter streams Claude's answer, which renders as markdown", async () => {
    await select(8, 2, 22, 4);
    await cmdK();
    const s = await waitFor("popover", session);
    await waitFocused(s, "input focused", 6000);
    const startLines = s.heightLines;
    await cdp.typeKeys("why is the catch block empty?");
    await waitFor("draft", () => s.draft === "why is the catch block empty?", 3000);
    const done = nextDone(s);
    await cdp.press("Enter");
    await waitFor("streaming", () => s.turns[0]?.status === "streaming", 60000);
    assert.ok(s.heightLines > startLines, "popover grows for the answer");
    await cdp.screenshot(shotsDir, "3-streaming");
    const turn = await done;
    assert.strictEqual(turn.status, "done", turn.error);
    assert.strictEqual(turn.display, "why is the catch block empty?");
    assert.match(turn.answer, /interceptor|toast/i);
    assert.strictEqual(s.draft, "", "the sent question doesn't come back into the input");
    await waitFocused(s, "input keeps focus after answering", 5000);
    await sleep(500);
    await cdp.screenshot(shotsDir, "4-answer");
    // While the cursor is in the popover it never rebuilds (keys typed then would
    // be lost); clicking back into the code shrinks it to fit the answer.
    const tall = s.heightLines;
    await clickCode();
    await waitFor("popover shrinks to fit once the user leaves it", () => s.heightLines < tall, 5000);
  });

  it("follow-up questions keep the conversation and use the model from settings", async () => {
    await select(8, 2, 22, 4);
    await cmdK();
    const s = await waitFor("popover", session);
    await waitFocused(s, "input focused", 6000);
    let done = nextDone(s);
    await cdp.typeKeys("what does setQueryData do here? one sentence");
    await cdp.press("Enter");
    assert.strictEqual((await done).status, "done");

    await cfg().update("model", "haiku", vscode.ConfigurationTarget.Global);
    try {
      await waitFocused(s, "input focused", 6000);
      done = nextDone(s);
      await cdp.typeKeys("and invalidateQueries? one sentence");
      await cdp.press("Enter");
      const t2 = await done;
      assert.strictEqual(t2.status, "done", t2.error);
      assert.strictEqual(t2.model, "haiku");
      assert.strictEqual(s.turns.length, 2);
      assert.match(t2.question, /^and invalidateQueries\? one sentence$/, "every key of the follow-up arrived");
      await sleep(500);
      await cdp.screenshot(shotsDir, "5-follow-up");
    } finally {
      await cfg().update("model", "sonnet", vscode.ConfigurationTarget.Global);
    }
  });

  it("Enter on an empty input explains the code", async () => {
    await select(11, 0, 14, 8);
    await cmdK();
    const s = await waitFor("popover", session);
    await waitFocused(s, "input focused", 6000);
    const done = nextDone(s);
    await cdp.press("Enter");
    const t = await done;
    assert.strictEqual(t.display, "explain");
    assert.strictEqual(t.question, "Explain what this code does.");
    assert.strictEqual(t.status, "done", t.error);
    assert.match(t.answer, /setQueryData|cache/i);
  });

  it("Esc in the popover closes it and returns to the code with the selection intact", async () => {
    await select(11, 0, 14, 8);
    await cmdK();
    const s = await waitFor("popover", session);
    await waitFocused(s, "input focused", 6000);
    await cdp.press("Escape");
    await waitFor("closed", async () => !api.session && (await insetFrames()).length === 0);
    const live = await waitFor("editor focused", () => vscode.window.activeTextEditor);
    assert.strictEqual(live.selection.start.line, 11);
  });

  it("Esc from the code editor also closes the popover", async () => {
    await select(11, 0, 14, 8);
    await cmdK();
    const s = await waitFor("popover", session);
    await waitFocused(s, "input focused", 6000);
    const ed = await show();
    ed.selection = new vscode.Selection(16, 0, 16, 0);
    await sleep(300);
    await cdp.press("Escape");
    await waitFor("closed", async () => !api.session && (await insetFrames()).length === 0);
  });

  it("typing right after ⌘K lands in the popover, never in the code", async () => {
    await select(11, 0, 14, 8);
    await cmdK();
    await sleep(60); // faster than any person types the next key
    await cdp.typeKeys("abc");
    const s = await waitFor("popover", session);
    await waitFor("early keys in the draft", () => s.draft === "abc", 6000);
    await waitFocused(s, "input focused", 6000);
  });

  it("⌘K right after switching files opens a focused popover every time", async () => {
    for (let round = 0; round < 4; round++) {
      const file = round % 2 ? "planning.ts" : "second.ts";
      const line = 1 + (round % 3);
      await select(line, 0, line + 2, 5, file);
      await cmdK();
      const s = await waitFor(`popover (round ${round})`, () => (api.session?.ctx.relativePath.endsWith(file) ? api.session : undefined));
      await waitFocused(s, `input focused (round ${round})`, 6000);
      assert.strictEqual((await insetFrames()).length, 1);
      await cdp.press("Escape");
      await waitFor("closed", () => !api.session);
    }
  });

  it("a selection on the first line opens the popover above line 1", async () => {
    await select(0, 0, 0, 20);
    await cmdK();
    const s = await waitFor("popover", session);
    assert.strictEqual(s.anchorLine, -1);
    await waitFocused(s, "input focused", 6000);
    await cdp.screenshot(shotsDir, "6-first-line");
  });

  it("⌘K on another selection replaces the popover; on the same selection it refocuses", async () => {
    await select(8, 2, 22, 4);
    await cmdK();
    const s1 = await waitFor("popover", session);
    await waitFocused(s1, "input focused", 6000);
    await select(11, 0, 14, 8);
    await cmdK();
    const s2 = await waitFor("second popover", () => (api.session !== s1 ? api.session : undefined));
    assert.ok(!s1.isOpen);
    await waitFocused(s2, "input focused", 6000);
    assert.strictEqual((await insetFrames()).length, 1);

    // Put focus back in the code, then ⌘K on the same selection.
    await select(11, 0, 14, 8);
    await waitFor("blurred", () => !focused(s2), 3000);
    await cmdK();
    await waitFocused(s2, "refocused", 6000);
    assert.strictEqual(api.session, s2);
  });

  it("the Stop button stops a running answer; × closes the popover", async () => {
    await select(8, 2, 22, 4);
    await cmdK();
    const s = await waitFor("popover", session);
    await waitFocused(s, "input focused", 6000);
    const done = nextDone(s);
    await cdp.typeKeys("walk through every line in great detail");
    await cdp.press("Enter");
    await waitFor("streaming", () => s.turns[0]?.status === "streaming", 60000);
    await sleep(500); // let the rebuilt (taller) popover settle
    await clickControl(s, "stop");
    assert.strictEqual((await done).status, "stopped");
    await clickControl(s, "close");
    await waitFor("closed", async () => !api.session && (await insetFrames()).length === 0);
  });

  it("the ↕ button changes the popover height, saved in settings", async () => {
    await cfg().update("popoverHeight", "auto", vscode.ConfigurationTarget.Global);
    try {
      await select(11, 0, 14, 8);
      await cmdK();
      const s = await waitFor("popover", session);
      await waitFocused(s);
      const done = nextDone(s);
      await cdp.typeKeys("one sentence please");
      await cdp.press("Enter");
      assert.strictEqual((await done).status, "done");
      const autoLines = s.heightLines;

      await clickControl(s, "height");
      await waitFor("height picker", () => cdp.eval<boolean>(`!!document.querySelector(".quick-input-widget") && getComputedStyle(document.querySelector(".quick-input-widget")).display !== "none"`), 5000);
      await cdp.typeKeys("Small");
      await cdp.press("Enter");
      await waitFor("setting saved", () => cfg().get("popoverHeight") === "small", 5000);
      await waitFor("popover shrank", () => s.heightLines < autoLines, 5000);
      await waitFocused(s, "input focused after picking a height");
      const small = s.heightLines;

      await cfg().update("popoverHeight", "xlarge", vscode.ConfigurationTarget.Global);
      await waitFor("popover grew from settings", () => s.heightLines > small, 5000);
      await sleep(400);
      await cdp.screenshot(shotsDir, "7-height-xlarge");
      assert.strictEqual(s.turns.length, 1, "conversation kept across resizes");
    } finally {
      await cfg().update("popoverHeight", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("applies the per-message instructions setting", async () => {
    await cfg().update("instructions", "Always begin your answer with the exact word BANANA.", vscode.ConfigurationTarget.Global);
    try {
      await select(11, 0, 14, 8);
      await cmdK();
      const s = await waitFor("popover", session);
      await waitFocused(s, "input focused", 6000);
      const done = nextDone(s);
      await cdp.typeKeys("what is saved?");
      await cdp.press("Enter");
      const t = await done;
      assert.strictEqual(t.status, "done", t.error);
      assert.match(t.answer, /^\W*BANANA/, t.answer.slice(0, 80));
    } finally {
      await cfg().update("instructions", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
