# Claude Inline Explain

Select code, click **✨ Explain**, ask a question, and Claude's answer streams into a popover right above the code. It works in Cursor and VS Code.

Answers come from your local **Claude Code CLI** and your **Claude subscription login**. The extension never uses an Anthropic API key (see [Billing](#billing-subscription-only)).

## Requirements

- [Claude Code](https://claude.com/claude-code) installed, with `claude` working in a terminal.
- A Claude subscription login: run `claude`, then `/login`, and choose your Claude account.

## Install

```sh
npm install
npm run package          # builds claude-inline-explain-<version>.vsix
cursor --install-extension claude-inline-explain-0.1.0.vsix   # or: code --install-extension …
```

In Cursor you can also use **Extensions → … → Install from VSIX…**.

## Use

1. Select some code. A **✨ Explain ⌘⌥E** button appears above the selection.
2. Click it, or press **⌘⌥E** (Ctrl+Alt+E on Windows/Linux). A popover opens above the code with the cursor in the input.
3. Type any question and press **Enter**. Press Enter on an empty input to get a plain explanation. Shift+Enter adds a new line.
4. Click **Add a follow-up…** to keep asking about the same selection. Earlier answers are sent as context.

The popover title bar has **Stop** (while an answer is streaming), **Select Model** (⚙) and **Close** (×, or Esc). Each answer has a **Copy** button.

You can also open the popover from the editor's right-click menu (**Explain with Claude**) or from the lightbulb / Quick Fix menu (⌘.).

> Cursor's own **Add to Chat / Quick Edit** bar is built into Cursor and isn't open to extensions, so the Explain button is a clickable CodeLens directly above the selection.

## Choosing the model

Any of these work:

- Click the **✨ sonnet** item in the status bar, or the ⚙ in the popover, or run **Claude Inline Explain: Select Model**.
- Edit your `settings.json` (user) or `.vscode/settings.json` (per project):

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
| `claudeInlineExplain.showCodeLens` | `true` | Show the clickable **✨ Explain** button above selections. |
| `claudeInlineExplain.showInlineHint` | `false` | Show a faded "✨ Explain ⌘⌥E" hint at the end of the selection. It isn't clickable, but it never shifts lines. |
| `claudeInlineExplain.showCodeAction` | `true` | Add "Explain with Claude" to the lightbulb menu. |
| `claudeInlineExplain.selectionDebounceMs` | `350` | How long a selection must stay still before the button appears. |
| `claudeInlineExplain.popoverPosition` | `above` | `above` or `below` the selection. |
| `claudeInlineExplain.contextLines` | `40` | Lines of surrounding code sent with the selection. |
| `claudeInlineExplain.defaultQuestion` | `Explain what this code does.` | Question used when you send an empty input. |
| `claudeInlineExplain.systemPrompt` | `""` | Replaces the built-in system prompt, which asks for concise answers. |
| `claudeInlineExplain.allowReadOnlyTools` | `false` | Let Claude use Read, Grep and Glob to look at other files. Better context, slower. |
| `claudeInlineExplain.loadClaudeCustomizations` | `false` | Load your CLAUDE.md, hooks, plugins and MCP servers. When off, the extension runs `--safe-mode`, which starts much faster. |
| `claudeInlineExplain.timeoutSeconds` | `180` | Stop a request after this long. |
| `claudeInlineExplain.showStatusBar` | `true` | Show the model switcher in the status bar. |

The extension also sets the default of `comments.openView` to `never`. Otherwise Cursor/VS Code pops open the Comments panel the first time a popover appears, and that panel takes focus from the popover input. If you want the old behaviour back, set `comments.openView` yourself.

## How it works

- **Popover:** the popover is the editor's inline comment widget (Comments API). A commenting range is offered only on the line above the selection, and only while a popover is opening. The extension then runs the built-in *Add Comment* on that line, so the input starts expanded and focused.
- **Claude:** each question runs `claude -p --output-format stream-json --include-partial-messages` in the workspace folder. The selection, surrounding lines and earlier Q&A are sent on stdin. By default the extension also passes `--tools ""`, `--safe-mode`, `--strict-mcp-config`, `--no-session-persistence` and a short system prompt. Answers stream as they arrive. Nothing is saved to your Claude Code session history.

## Billing: subscription only

The extension refuses to run Claude through an API key, with three checks:

1. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, base-URL overrides and the Bedrock/Vertex/Foundry switches are removed from the environment before `claude` starts.
2. `claude auth status` must report a `claude.ai` login with no `apiKeySource`. If an API key or `apiKeyHelper` is configured, you get an error and no request is sent.
3. If a session still reports an `apiKeySource` other than `none`, the process is killed before it answers.

## Troubleshooting

- **"Could not find the Claude Code CLI"**: set `claudeInlineExplain.claudePath` to the output of `which claude`.
- **"not logged in" / "not a Claude subscription"**: run `claude` in a terminal and `/login` with your Claude account.
- **No Explain button**: check that `editor.codeLens` is on, or use ⌘⌥E / right-click. The button appears after the selection has been still for `selectionDebounceMs`.
- **Logs**: run **Claude Inline Explain: Show Logs**.

## Development

```sh
npm install
npm run compile
npm run test:cli   # runs the Claude Code runner against your real CLI (streaming, models, stop, billing guards)
npm test           # opens Cursor (or VS Code) with the extension and drives it with real clicks and keys
```

`npm test` saves a screenshot of each step to `test-screenshots/`. Set `EDITOR_EXECUTABLE` to test a different editor build.
