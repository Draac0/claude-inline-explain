// Launches an editor with the extension loaded and runs the integration suite.
// Defaults to Cursor when installed; set EDITOR_EXECUTABLE to use another
// VS Code build, or unset it and remove Cursor to download stock VS Code.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

const CURSOR = "/Applications/Cursor.app/Contents/MacOS/Cursor";

async function main() {
  // Set when launched from inside VS Code/Cursor; it would start the editor as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = path.resolve(__dirname, "../..");
  const exe = process.env.EDITOR_EXECUTABLE || (fs.existsSync(CURSOR) ? CURSOR : undefined);
  const userData = fs.mkdtempSync("/tmp/cie-") // short: the editor puts an IPC socket in here;
  // Mirror a Cursor keymap where ⌘K and Escape are user-level bindings (which beat
  // extension bindings). The suite adds the extension's own entries with its
  // "Add ⌘K / Esc Keybindings" command, as the setup does for users.
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(userData, "User", "keybindings.json"),
    JSON.stringify(
      [
        { key: "cmd+k", command: "aipopup.action.modal.generate", when: "editorFocus && !composerBarIsVisible" },
        { key: "escape", command: "cancelSelection", when: "editorHasSelection && textInputFocus" },
      ],
      null,
      2
    )
  );
  const port = process.env.CDP_PORT || "9339";
  process.env.CDP_PORT = port;
  process.env.SCREENSHOT_DIR ||= path.join(root, "test-screenshots");
  console.log(`userData: ${userData}`);
  console.log(`Editor: ${exe ?? "downloaded VS Code"}; CDP port ${port}`);
  await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, "suite", "index"),
    extensionTestsEnv: { MOCHA_GREP: process.env.MOCHA_GREP ?? "", CIE_DEBUG: "1", CIE_KEYLOG: process.env.CIE_KEYLOG ?? "", CDP_PORT: port, SCREENSHOT_DIR: process.env.SCREENSHOT_DIR },
    launchArgs: [
      path.join(root, "test-fixtures"),
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${port}`,
      // The popover uses the proposed "editorInsets" API (see README).
      "--enable-proposed-api=draac0.claude-inline-explain",
      // Keep the window "visible" when other windows cover it; otherwise
      // Chromium won't move focus inside it.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
