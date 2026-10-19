# Claude Inline Explain

Select code, press **⌘K**, ask a question, and Claude's answer streams into a popover drawn right inside the editor, above the code. It works in Cursor and VS Code.

Answers come from your local **Claude Code CLI** and your **Claude subscription login**. The extension never uses an Anthropic API key (see [Billing](#billing-subscription-only)).

> **One-time setup required.** The popover is drawn with the editor's *webview inset* API, which is still a *proposed* API. Editors only allow proposed APIs for extensions you list in `argv.json`, so there's a one-line setup and a restart. See [Install](#install). The setup is what an editor update is most likely to break; [If the popover stops working after a Cursor or VS Code update](#if-the-popover-stops-working-after-a-cursor-or-vs-code-update) explains how to check and fix it.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed, with `claude` working in a terminal.
- A Claude subscription login: run `claude`, then `/login`, and choose your Claude account.
- Cursor, or VS Code 1.90 or newer.

## Install

1. Build and install the extension:

   ```sh
   npm install
   npm run package    # builds claude-inline-explain-<version>.vsix
   ```

   In Cursor use **Extensions → ⋯ → Install from VSIX…**, or run Cursor's command-line tool: `/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension claude-inline-explain-<version>.vsix` (the `cursor` shell command is often just an alias for `open -a Cursor`, which can't install extensions). In VS Code: `code --install-extension claude-inline-explain-<version>.vsix`.

2. Allow the extension to use the inline popover API. Either:

   - run **Claude Inline Explain: Set Up Inline Popover (one-time)** from the Command Palette, or
   - run **Preferences: Configure Runtime Arguments** (opens `argv.json`) and add:

     ```jsonc
     "enable-proposed-api": ["draac0.claude-inline-explain"]
     ```

   `argv.json` lives at `~/.cursor/argv.json` for Cursor and `~/.vscode/argv.json` for VS Code. The setup command keeps a copy of the old file as `argv.json.bak`.

3. **Quit the editor completely and open it again.** `argv.json` is only read when the app starts, so **Developer: Reload Window** is not enough.

If you skip step 2 or 3, pressing ⌘K shows a message with a **Set up now** button instead of the popover.

## Use

1. Select some code. A **✨ Explain ⌘K** button appears above the selection.
2. Press **⌘K** (or click the button; ⌘⌥E, or Ctrl+Alt+E on Windows/Linux, also works). The popover opens above the code with the cursor in its input box. Typing straight away is fine: keys pressed while it opens go into the popover, not into your code.
3. Type a question and press **Enter**. Press Enter on an empty box to get a plain explanation. **Shift+Enter** adds a new line.
4. The answer streams in. The input stays focused, so you can type a follow-up right away. Earlier questions and answers are sent along as context.
5. Press **Esc** to close the popover and return to your code. Esc also works when the cursor is back in the code and nothing is selected.

The popover header has a **model** button (click to switch models), a **↕ height** button (see [Popover height](#popover-height)), **Stop** (while an answer is streaming) and **×** (close). Each answer has a **Copy** button. Pressing ⌘K again on the same selection puts the cursor back in the popover; ⌘K on a different selection replaces it.

You can also open the popover from the editor's right-click menu (**Explain with Claude**) or the lightbulb / Quick Fix menu (⌘.).

### ⌘K and Cursor's Quick Edit

With code selected, ⌘K opens this popover instead of Cursor's Quick Edit. Quick Edit still works from the **Quick Edit** button on Cursor's selection bar, and ⌘K still opens it when nothing is selected.

### If ⌘K or Esc don't work

Keybindings in your own `keybindings.json` beat extension keybindings. If yours binds ⌘K or Escape, which Cursor's exported keymaps often do, add the entries from [keybindings.cursor-overrides.json](keybindings.cursor-overrides.json) at the **end** of your `keybindings.json`. Open it with **Preferences: Open Keyboard Shortcuts (JSON)**.

## Answer style for every question

Put your rules in `claudeInlineExplain.instructions`. They're added to every question, on top of the built-in prompt:

```jsonc
"claudeInlineExplain.instructions": "Keep the explanation short and simple. Use simple Indian English. Where it helps, show a small example."
```

Run **Claude Inline Explain: Edit Answer Instructions** to jump to this setting. To replace the built-in prompt entirely, use `claudeInlineExplain.systemPrompt` instead.

## Text size and font

The popover uses your editor font size by default. Change it with:

```jsonc
"claudeInlineExplain.fontSize": 16,                 // 0 = same as editor.fontSize
"claudeInlineExplain.fontFamily": "Inter, sans-serif" // empty = system UI font; code always uses your editor font
```

## Popover height

Click **↕** in the popover header (or run **Claude Inline Explain: Set Popover Height**) and pick a size. The popover resizes right away, and the choice is saved as a setting:

| Choice | Height while showing answers |
| --- | --- |
| **Auto** (default) | Grows while the answer streams, up to `claudeInlineExplain.maxHeight` (60% of the visible editor by default). Afterwards the card fits the answer, and the leftover space is given back when you click back into your code. |
| **Small** | About 25% of the visible editor. |
| **Medium** | About 40%. |
| **Large** | About 60%. |
| **Extra large** | About 80%. |

Or set it in `settings.json`:

```jsonc
"claudeInlineExplain.popoverHeight": "large"   // auto | small | medium | large | xlarge
```

A popover that only has the question box stays compact whatever you choose. Longer answers scroll inside the popover.

## Choosing the model

- Click the model button in the popover, or the **✨ sonnet** item in the status bar, or run **Claude Inline Explain: Select Model**.
- Or edit your `settings.json` (user) or `.vscode/settings.json` (per project):

```jsonc
{
  "claudeInlineExplain.model": "sonnet",   // sonnet | opus | haiku | fable | default
  "claudeInlineExplain.customModel": "",   // any `claude --model` value, e.g. "claude-sonnet-5-5"; overrides `model`
  "claudeInlineExplain.effort": ""         // "", low, medium, high, xhigh, max
}
```

`default` uses whatever model your Claude Code CLI is set to.

## All settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeInlineExplain.model` | `sonnet` | Model alias passed to `claude --model`. |
| `claudeInlineExplain.customModel` | `""` | Full model name; overrides `model` when set. |
| `claudeInlineExplain.effort` | `""` | Reasoning effort (`claude --effort`). Lower is faster. |
| `claudeInlineExplain.claudePath` | `""` | Path to `claude`. Empty means auto-detect: PATH, `~/.local/bin`, `~/.claude/local`, Homebrew, then your login shell. |
| `claudeInlineExplain.instructions` | `""` | Your style rules, added to every question. |
| `claudeInlineExplain.defaultQuestion` | `Explain what this code does.` | Question used when you send an empty input. |
| `claudeInlineExplain.systemPrompt` | `""` | Replaces the built-in system prompt, which asks for concise answers. |
| `claudeInlineExplain.fontSize` | `0` | Popover text size in px; `0` uses `editor.fontSize`. |
| `claudeInlineExplain.fontFamily` | `""` | Popover font; empty uses the system UI font. |
| `claudeInlineExplain.popoverHeight` | `auto` | Popover height while showing answers: `auto`, `small`, `medium`, `large`, `xlarge`. Also settable from the **↕** button. |
| `claudeInlineExplain.maxHeight` | `0.6` | Largest height in `auto` mode, as a fraction of the visible editor. Longer answers scroll inside it. |
| `claudeInlineExplain.popoverPosition` | `above` | `above` or `below` the selection. |
| `claudeInlineExplain.contextLines` | `40` | Lines of surrounding code sent with the selection. |
| `claudeInlineExplain.showCodeLens` | `true` | Show the clickable **✨ Explain** button above selections. |
| `claudeInlineExplain.showInlineHint` | `false` | Show a faded "✨ Explain ⌘K" hint at the end of the selection instead (not clickable, never shifts lines). |
| `claudeInlineExplain.showCodeAction` | `true` | Add "Explain with Claude" to the lightbulb menu. |
| `claudeInlineExplain.selectionDebounceMs` | `350` | How long a selection must stay still before the button appears. |
| `claudeInlineExplain.allowReadOnlyTools` | `false` | Let Claude use Read, Grep and Glob to look at other files. Better context, slower. |
| `claudeInlineExplain.loadClaudeCustomizations` | `false` | Load your CLAUDE.md, hooks, plugins and MCP servers. When off, the extension runs `--safe-mode`, which starts much faster. |
| `claudeInlineExplain.timeoutSeconds` | `180` | Stop a request after this long. |
| `claudeInlineExplain.showStatusBar` | `true` | Show the model switcher in the status bar. |

## How the popover works

### Why a webview inset

Extensions can't add anything to Cursor's own ⌘K popover; it's built into Cursor and has no extension API. Of the inline UI that extensions *can* use, only these show up between lines of code:

| Approach | Inline | Text input | Own styling | Why it isn't used |
| --- | --- | --- | --- | --- |
| Comments API (comment threads) | yes | yes | no | Depends on "commenting ranges" and the editor's comment settings (Zen mode, *Toggle Editor Commenting*, `comments.visible`), the editor's own fonts, and a collapsed reply box. Versions up to 0.2.x used this and kept failing with "The cursor must be within a commenting range". |
| Hover, CodeLens, decorations | yes | no | no | Can't type into them. |
| Peek view | yes | no | editor font only | Read-only. |
| Quick input / side panel webview | no | yes | partly | Not next to the code. |
| **Webview editor inset** | **yes** | **yes** | **full HTML/CSS** | Proposed API, needs the one-time setup above. |

A webview inset is a real HTML page that the editor draws in a *view zone* between two lines of code, which is the same kind of space Cursor's own inline widgets use. The extension owns everything in it: the layout, fonts, input box, markdown rendering and keyboard handling.

### The pieces

- `src/vscode.proposed.editorInsets.d.ts`: the API's TypeScript definition, copied from [microsoft/vscode `vscode.proposed.editorInsets.d.ts`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.editorInsets.d.ts) ([discussion: issue #85682](https://github.com/microsoft/vscode/issues/85682)):

  ```ts
  window.createWebviewTextEditorInset(editor, line, height, options): WebviewEditorInset
  // WebviewEditorInset: { editor, line, height, webview, onDidDispose, dispose() }
  ```

- `package.json` → `"enabledApiProposals": ["editorInsets"]`: declares the proposal. The editor refuses the call unless this is present **and** the extension ID is in `argv.json`'s `enable-proposed-api`.
- `src/popover.ts`: creates the inset (`createInset`), sends state to it, sizes it, and runs Claude.
- `media/popover.js` and `media/popover.css` (the page's HTML is built in `popover.ts`): the popover UI. Markdown is rendered with `markdown-it` (copied into `media/vendor/` at build time) with raw HTML disabled.
- `src/argv.ts`: finds `argv.json` (using the editor's `product.json` → `dataFolderName`, e.g. `.cursor`) and adds the extension ID.

### Behaviour worth knowing

- **Height:** an inset's height (in editor lines) is fixed when it's created, so resizing means rebuilding the webview (state, draft and focus carry over). For about 0.3 s during a rebuild there is no input, so the popover only rebuilds when you can't be mid-typing: when you press Enter (it grows to the chosen height, or the maximum in `auto`), when you change the height, and, in `auto`, after you leave the popover (it shrinks to fit). While you're in it, the card shrinks to its content with CSS instead. Each rebuild carries over the conversation, your draft and the input focus.
- **Focus:** a new webview doesn't have keyboard focus. The popover takes it with `window.focus()` and retries for up to 1.5 s, or until it becomes visible if the window was in the background. Until then, the extension briefly takes over the editor's `type` command so that keys you press go into the popover, not your code. If another extension owns `type` (for example Vim), that guard is skipped.
- **Width:** the inset is as wide as the editor's scrollable content. The popover measures how much of it is actually visible (an `IntersectionObserver`) and fits its card to that.

## If the popover stops working after a Cursor or VS Code update

Proposed APIs can change or disappear in any editor release, and Cursor rebases on VS Code regularly. Here's what can happen and how to fix it.

### 1. You see "needs one-time setup" or "can't draw its popover"

- **"needs one-time setup":** the extension ID isn't in `argv.json`. Click **Set up now**, or add it by hand as in [Install](#install), then **quit and reopen** the editor.
- **"can't draw its popover even though … enables it":** check, in this order:
  1. **Was the editor fully restarted?** Quit it (⌘Q), not just Reload Window.
  2. **Is `argv.json` still valid?** A syntax error makes the editor ignore the whole file. Open it with **Preferences: Configure Runtime Arguments** and look for red squiggles. Updates sometimes rewrite this file; re-add the line if it's gone.
  3. **What does the log say?** Run **Claude Inline Explain: Show Logs** and look for a line starting `inset API unavailable:`. Then check **Help → Toggle Developer Tools → Console** for messages naming `draac0.claude-inline-explain`:
     - `CANNOT use API proposal: editorInsets`: setup isn't applied (go back to steps 1–2), or the editor now only allows proposals for its own built-in extensions.
     - `... requests proposal names that no longer exist` / `unknown proposal`: the proposal was **renamed or removed**. See section 2.
     - `createWebviewTextEditorInset is not a function`: the API was **removed**. See section 2.

### 2. Check whether the editor still ships the API

Run these against your installed editor (macOS paths shown; adjust for your install):

```sh
APP=/Applications/Cursor.app/Contents/Resources/app        # VS Code: /Applications/Visual\ Studio\ Code.app/Contents/Resources/app
grep -c createWebviewTextEditorInset "$APP/out/vs/workbench/api/node/extensionHostProcess.js"   # > 0: extension-side API exists
grep -c '\$createEditorInset'        "$APP/out/vs/workbench/workbench.desktop.main.js"          # > 0: editor-side implementation exists
grep -o '"editorInsets"' "$APP/out/vs/workbench/api/node/extensionHostProcess.js" | head -1      # the proposal name it checks
jq -r '.version + " (VS Code " + (.vscodeVersion // "?") + ")"' "$APP/product.json"            # which version you're on
```

- **All three found:** the API is still there; the problem is the setup (section 1).
- **The proposal name changed:** update `"enabledApiProposals"` in `package.json` and the module in `src/vscode.proposed.editorInsets.d.ts` to match the new [upstream `vscode.proposed.*.d.ts`](https://github.com/microsoft/vscode/tree/main/src/vscode-dts), rebuild, reinstall.
- **The signature changed:** compare upstream's `vscode.proposed.editorInsets.d.ts` with ours and adjust `createInset()` in `src/popover.ts`. It's the only place the API is called.
- **The API is gone:** there is no supported way left to draw an extension-owned input inside the editor. Until a replacement exists, stay on (or roll back to) the last editor version where the commands above find the API, and turn off the editor's auto-update.

### 3. The popover appears but behaves oddly

- **Keys go into the code instead of the popover:** the focus behaviour of webviews changed. The logic is in `grabFocus()` in `media/popover.js` and the `type` guard in `startTypeGuard()` in `src/extension.ts`. **Show Logs** shows `popover input focused/blurred` lines that tell you whether focus arrived.
- **Popover is cut off or the wrong height:** the view-zone sizing changed. See `resize()` / `fitLines()` in `src/popover.ts` and the `size` message in `media/popover.js`.
- **⌘K or Esc do nothing:** see [If ⌘K or Esc don't work](#if-k-or-esc-dont-work). An update may have added new default bindings.

## Billing: subscription only

The extension refuses to run Claude through an API key, with three checks:

1. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, base-URL overrides and the Bedrock/Vertex/Foundry switches are removed from the environment before `claude` starts.
2. `claude auth status` must report a `claude.ai` login with no `apiKeySource`. If an API key or `apiKeyHelper` is configured, you get an error and no request is sent.
3. If a session still reports an `apiKeySource` other than `none`, the process is killed before it answers.

Each question runs `claude -p --output-format stream-json --include-partial-messages` in the workspace folder, with the selection, surrounding lines and earlier Q&A on stdin. By default it also passes `--tools ""`, `--safe-mode`, `--strict-mcp-config` and `--no-session-persistence`, so nothing is saved to your Claude Code session history.

## Other troubleshooting

- **"Could not find the Claude Code CLI"**: set `claudeInlineExplain.claudePath` to the output of `which claude`.
- **"not logged in" / "not a Claude subscription"**: run `claude` in a terminal and `/login` with your Claude account.
- **No Explain button**: check that `editor.codeLens` is on, or use ⌘K / right-click. The button appears after the selection has been still for `selectionDebounceMs`.
- **Logs**: run **Claude Inline Explain: Show Logs**.

## Development

```sh
npm install
npm run compile    # TypeScript + copies markdown-it into media/vendor
npm run test:cli   # runs the Claude Code runner against your real CLI (streaming, models, stop, billing guards)
npm test           # opens Cursor (or VS Code) with the extension and drives the popover with real keys and clicks
```

`npm test` launches the editor with `--enable-proposed-api=draac0.claude-inline-explain`, so it doesn't need `argv.json`. It also passes `--disable-backgrounding-occluded-windows` and brings its window to the front before input, because the tests share your desktop and focus behaves differently in a background window. Screenshots of each step go to `test-screenshots/`. Set `EDITOR_EXECUTABLE` to test another editor build.
