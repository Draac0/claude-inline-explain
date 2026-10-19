// Reads and edits the editor's argv.json ("Preferences: Configure Runtime
// Arguments"), where `enable-proposed-api` turns on proposed APIs for listed
// extensions. Cursor keeps it in ~/.cursor/argv.json, VS Code in ~/.vscode/argv.json.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const ARGV_KEY = "enable-proposed-api";

// The data folder comes from the running editor's product.json (".cursor",
// ".vscode", ".vscode-insiders", ...).
export function argvPath(appRoot: string): string {
  let dataFolder = ".vscode";
  try {
    const product = JSON.parse(fs.readFileSync(path.join(appRoot, "product.json"), "utf8"));
    if (typeof product.dataFolderName === "string" && product.dataFolderName) dataFolder = product.dataFolderName;
  } catch {
    // keep the default
  }
  return path.join(os.homedir(), dataFolder, "argv.json");
}

const COMMENTS = /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

// Replaces comments with spaces, keeping every other character's offset.
export function blankComments(text: string): string {
  return text.replace(COMMENTS, (m, str) => str ?? m.replace(/[^\n]/g, " "));
}

// argv.json is JSON with comments and trailing commas.
function parseJsonc(text: string): any {
  return JSON.parse(blankComments(text).replace(/,(\s*[\]}])/g, "$1"));
}

export function enabledIds(file: string): string[] {
  try {
    const v = parseJsonc(fs.readFileSync(file, "utf8"))?.[ARGV_KEY];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function isEnabled(file: string, id: string): boolean {
  return enabledIds(file).some((x) => x.toLowerCase() === id.toLowerCase());
}

// Adds `id` to "enable-proposed-api", keeping the file's comments and layout.
// Writes argv.json.bak first. Returns false if it was already there.
export function enable(file: string, id: string): boolean {
  if (isEnabled(file, id)) return false;
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, "utf8") : "{\n}\n";
  if (exists) fs.copyFileSync(file, file + ".bak");

  let next: string;
  const keyAt = text.search(new RegExp(`"${ARGV_KEY}"\\s*:\\s*\\[`));
  if (keyAt >= 0) {
    const open = text.indexOf("[", keyAt);
    const close = text.indexOf("]", open);
    const inner = text.slice(open + 1, close).trim();
    next = text.slice(0, open + 1) + (inner ? `${inner.replace(/,\s*$/, "")}, ` : "") + JSON.stringify(id) + text.slice(close);
  } else {
    // Insert as the object's first property, so the comma goes after our
    // entry and never lands inside a trailing comment.
    const blanked = blankComments(text);
    const open = blanked.indexOf("{");
    if (open < 0) throw new Error(`${file} is not a JSON object`);
    const close = blanked.lastIndexOf("}");
    const hasProps = blanked.slice(open + 1, close).trim().length > 0;
    const entry = `\n\t// Lets Claude Inline Explain draw its inline popover (proposed "editorInsets" API).\n\t"${ARGV_KEY}": [${JSON.stringify(id)}]${hasProps ? "," : "\n"}`;
    next = text.slice(0, open + 1) + entry + text.slice(open + 1);
  }
  parseJsonc(next); // never write a file the editor can't read
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}
