// Runs the local Claude Code CLI (`claude -p`) and streams its answer.
// Kept free of the `vscode` module so it can be tested with plain Node.
//
// Billing rule: this extension only ever uses the user's Claude subscription
// login. API credentials are stripped from the child environment, the login is
// verified with `claude auth status`, and any session that reports an API key
// source is killed.

import { spawn, execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Env vars that would make Claude Code bill an API account or route through a
// third-party provider instead of the subscription login.
const API_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

// Set by a parent Claude Code session; harmless to drop and avoids nested-session checks.
const SESSION_ENV_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];

export class ClaudeError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

export interface RunOptions {
  prompt: string;
  systemPrompt: string;
  model?: string;
  effort?: string;
  cwd: string;
  claudePath?: string;
  readOnlyTools: boolean;
  loadCustomizations: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  log?: (line: string) => void;
}

export interface RunResult {
  text: string;
  model?: string;
  durationMs?: number;
}

let loginShellPath: Promise<string | undefined> | undefined;
let authVerified = false;

// GUI-launched editors on macOS/Linux get a minimal PATH, so ask the login shell.
function getLoginShellPath(): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  loginShellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(shell, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
      const m = /__PATH__(.*)__PATH__/.exec(stdout || "");
      resolve(err && !m ? undefined : m?.[1]);
    });
  });
  return loginShellPath;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

async function buildPath(): Promise<string> {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const parts = [...(process.env.PATH || "").split(path.delimiter), ...extra];
  const shellPath = await getLoginShellPath();
  if (shellPath) parts.push(...shellPath.split(path.delimiter));
  return [...new Set(parts.filter(Boolean))].join(path.delimiter);
}

export async function resolveClaudePath(configured?: string): Promise<{ bin: string; envPath: string }> {
  const envPath = await buildPath();
  if (configured) {
    const p = configured.replace(/^~(?=$|[\\/])/, os.homedir());
    if (!isExecutable(p)) {
      throw new ClaudeError(`Configured claudePath is not executable: ${p}`, "Fix `claudeInlineExplain.claudePath` in settings.");
    }
    return { bin: p, envPath };
  }
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of envPath.split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return { bin: candidate, envPath };
    }
  }
  throw new ClaudeError(
    "Could not find the Claude Code CLI (`claude`).",
    "Install Claude Code (https://claude.com/claude-code) or set `claudeInlineExplain.claudePath`."
  );
}

function childEnv(envPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: envPath };
  for (const k of [...API_ENV_VARS, ...SESSION_ENV_VARS]) delete env[k];
  return env;
}

const LOGIN_HINT = "Run `claude` in a terminal and use /login to sign in with your Claude subscription.";

// Confirms Claude Code will authenticate with the subscription login, not an API key.
export async function verifySubscriptionAuth(bin: string, envPath: string, log?: (l: string) => void): Promise<void> {
  if (authVerified) return;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(bin, ["auth", "status"], { env: childEnv(envPath), timeout: 20000, shell: bin.endsWith(".cmd") }, (err, out, errOut) => {
      if (out && out.trim().startsWith("{")) resolve(out);
      else reject(new ClaudeError(`\`claude auth status\` failed: ${(errOut || err?.message || "").trim()}`, LOGIN_HINT));
    });
  });
  let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string; apiKeySource?: string };
  try {
    status = JSON.parse(stdout);
  } catch {
    throw new ClaudeError("Could not parse `claude auth status` output.", LOGIN_HINT);
  }
  log?.(`auth status: loggedIn=${status.loggedIn} method=${status.authMethod} provider=${status.apiProvider} apiKeySource=${status.apiKeySource ?? "none"}`);
  if (!status.loggedIn) throw new ClaudeError("Claude Code is not logged in.", LOGIN_HINT);
  if (status.apiKeySource && status.apiKeySource !== "none") {
    throw new ClaudeError(
      `Claude Code is configured to use an API key (${status.apiKeySource}). This extension only uses your Claude subscription.`,
      "Remove the API key / apiKeyHelper from your Claude Code settings, then sign in with /login."
    );
  }
  if (status.authMethod !== "claude.ai" || (status.apiProvider && status.apiProvider !== "firstParty")) {
    throw new ClaudeError(
      `Claude Code is signed in via "${status.authMethod}" (${status.apiProvider}), not a Claude subscription.`,
      LOGIN_HINT
    );
  }
  authVerified = true;
}

export function resetAuthCache(): void {
  authVerified = false;
}

export async function runClaude(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  const { bin, envPath } = await resolveClaudePath(opts.claudePath);
  await verifySubscriptionAuth(bin, envPath, log);

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--system-prompt", opts.systemPrompt,
  ];
  if (opts.model && opts.model !== "default") args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (!opts.loadCustomizations) args.push("--safe-mode");
  if (opts.readOnlyTools) {
    args.push("--tools", "Read,Grep,Glob", "--allowedTools", "Read", "Grep", "Glob", "--permission-mode", "dontAsk");
  } else {
    args.push("--tools", "");
  }
  log(`spawn ${bin} ${args.map((a) => (a === opts.systemPrompt ? "<system-prompt>" : a)).join(" ")} (cwd=${opts.cwd})`);

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: childEnv(envPath),
      stdio: ["pipe", "pipe", "pipe"],
      shell: bin.endsWith(".cmd"),
    });

    let settled = false;
    let buffer = "";
    let stderr = "";
    let streamed = "";
    let model: string | undefined;

    const finish = (err: Error | undefined, result?: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill();
      err ? reject(err) : resolve(result!);
    };
    const onAbort = () => finish(new ClaudeError("Stopped."));
    const timer = setTimeout(
      () => finish(new ClaudeError(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s.`, "Raise `claudeInlineExplain.timeoutSeconds` or pick a faster model.")),
      opts.timeoutMs
    );
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort);

    const handle = (msg: any) => {
      if (msg.type === "system" && msg.subtype === "init") {
        model = msg.model;
        log(`session init: model=${msg.model} apiKeySource=${msg.apiKeySource}`);
        if (msg.apiKeySource && msg.apiKeySource !== "none") {
          resetAuthCache();
          finish(new ClaudeError(`Refusing to run: Claude Code picked an API key (${msg.apiKeySource}).`, LOGIN_HINT));
        }
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          streamed += ev.delta.text;
          opts.onText?.(ev.delta.text);
        } else if (ev?.type === "message_start" && streamed && !streamed.endsWith("\n\n")) {
          // A new assistant message after tool use: keep paragraphs apart.
          streamed += "\n\n";
          opts.onText?.("\n\n");
        }
      } else if (msg.type === "result") {
        const text = typeof msg.result === "string" ? msg.result : streamed;
        if (msg.is_error || msg.subtype !== "success") {
          const detail = text || (Array.isArray(msg.errors) ? msg.errors.join("; ") : "") || msg.subtype;
          if (/log ?in|auth|credential|api key/i.test(detail)) resetAuthCache();
          finish(new ClaudeError(`Claude Code returned an error: ${detail}`));
        } else {
          finish(undefined, { text: streamed || text, model, durationMs: msg.duration_ms });
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          handle(JSON.parse(line));
        } catch (e) {
          log(`unparsed stdout: ${line.slice(0, 200)}`);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", (e) => finish(new ClaudeError(`Failed to start Claude Code: ${e.message}`)));
    child.on("close", (code) => {
      if (stderr.trim()) log(`stderr: ${stderr.trim()}`);
      finish(new ClaudeError(`Claude Code exited (code ${code}) without an answer.${stderr.trim() ? " " + stderr.trim().slice(0, 500) : ""}`));
    });

    child.stdin.on("error", () => {});
    child.stdin.end(opts.prompt);
  });
}
