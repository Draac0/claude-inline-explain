// Exercises the real Claude Code CLI through the runner (no VS Code needed).
// Run with: npm run test:cli
import * as assert from "assert";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { runClaude, RunOptions, resetAuthCache } from "../claude";
import { buildPrompt, DEFAULT_SYSTEM_PROMPT } from "../prompt";

const ctx = {
  relativePath: "src/planning.ts",
  languageId: "typescript",
  startLine: 11,
  endLine: 25,
  before: "const queryClient = useQueryClient();\n",
  after: "\nreturn <Editor onSave={handleSave} />;\n",
  selection: `const handleSave = async (draft: PlanningDocDraft) => {
  try {
    const saved = await savePlanningDoc(batchRecordId, toSaveRequest(draft));
    queryClient.setQueryData(queryKeys.batchRecords.planningDoc(batchRecordId), saved);
    await queryClient.invalidateQueries({ queryKey: queryKeys.batchRecords.constants(batchRecordId) });
    showToast("Planning doc saved", "success");
  } catch {
    // apiService interceptor surfaces the error toast
  }
};`,
};

const base = (over: Partial<RunOptions>): RunOptions => ({
  prompt: buildPrompt(ctx, [], "Explain what this code does."),
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  model: "sonnet",
  cwd: os.tmpdir(),
  readOnlyTools: false,
  loadCustomizations: false,
  timeoutMs: 120_000,
  log: (l) => console.log("   log:", l),
  ...over,
});

async function main() {
  // Plant an API key in our own env: the runner must strip it and still use the subscription.
  process.env.ANTHROPIC_API_KEY = "sk-ant-this-must-never-be-used";

  console.log("1) streaming explain with sonnet");
  let deltas = 0;
  const t0 = Date.now();
  const r1 = await runClaude(base({ onText: () => deltas++ }));
  console.log(`   ${deltas} deltas, ${Date.now() - t0}ms, model=${r1.model}\n---\n${r1.text}\n---`);
  assert.ok(deltas > 1, "expected streamed deltas");
  assert.ok(r1.text.length > 40, "expected a real answer");
  assert.match(r1.model ?? "", /sonnet/);

  console.log("2) follow-up with history, model haiku");
  const r2 = await runClaude(
    base({ model: "haiku", prompt: buildPrompt(ctx, [{ question: "Explain what this code does.", answer: r1.text }], "Why is the catch block empty? One sentence.") })
  );
  console.log(`   model=${r2.model}\n---\n${r2.text}\n---`);
  assert.match(r2.model ?? "", /haiku/);
  assert.match(r2.text, /interceptor|toast|error/i);

  console.log("3) abort mid-stream");
  const ac = new AbortController();
  let got = "";
  await assert.rejects(
    runClaude(base({ prompt: "Count from 1 to 300, one number per line.", signal: ac.signal, onText: (d) => { got += d; if (got.length > 20) ac.abort(); } })),
    /Stopped/
  );
  console.log(`   aborted after ${got.length} chars`);

  console.log("4) bad claudePath is reported clearly");
  await assert.rejects(runClaude(base({ claudePath: "/nonexistent/claude" })), /not executable/);

  console.log("5) refuses when Claude Code reports an API key, and never spawns a session");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const fake = path.join(dir, "claude");
  const marker = path.join(dir, "session-started");
  fs.writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","apiKeySource":"apiKeyHelper"}'; exit 0; fi\ntouch "${marker}"\n`,
    { mode: 0o755 }
  );
  resetAuthCache();
  await assert.rejects(runClaude(base({ claudePath: fake })), /only uses your Claude subscription/);
  assert.ok(!fs.existsSync(marker), "session must not start when an API key is configured");

  console.log("6) kills a session whose init reports an API key");
  fs.writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0; fi\necho '{"type":"system","subtype":"init","model":"x","apiKeySource":"ANTHROPIC_API_KEY"}'\nsleep 5\necho '{"type":"result","subtype":"success","result":"billed to API"}'\n`,
    { mode: 0o755 }
  );
  resetAuthCache();
  await assert.rejects(runClaude(base({ claudePath: fake })), /Refusing to run/);
  resetAuthCache();

  console.log("\nALL CLI TESTS PASSED");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
