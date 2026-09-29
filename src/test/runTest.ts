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
  const port = process.env.CDP_PORT || "9339";
  process.env.CDP_PORT = port;
  process.env.SCREENSHOT_DIR ||= path.join(root, "test-screenshots");
  console.log(`Editor: ${exe ?? "downloaded VS Code"}; CDP port ${port}`);
  await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, "suite", "index"),
    extensionTestsEnv: { CIE_DEBUG: "1", CDP_PORT: port, SCREENSHOT_DIR: process.env.SCREENSHOT_DIR },
    launchArgs: [
      path.join(root, "test-fixtures"),
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${userData}`,
      `--remote-debugging-port=${port}`,
    ],
  });
}

main().catch((err) => {
  console.error("Integration tests failed:", err);
  process.exit(1);
});
