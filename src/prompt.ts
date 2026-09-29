// Builds the prompt sent to Claude Code. No `vscode` import so it stays unit-testable.

export const DEFAULT_SYSTEM_PROMPT = `You are an expert software engineer answering questions about code inside the user's editor. Your answer is shown in a small inline popover right next to the selected code.

- Answer the user's question about the selected code directly. Lead with the answer; no preamble, no restating the question, no sign-off.
- Be concise: short paragraphs or bullet points, usually under 150 words. Go deeper only when the user asks for it.
- Use Markdown. Put identifiers in backticks. Use fenced code blocks with a language tag when showing code.
- The surrounding code is context only; focus on the selection. If something the code depends on isn't visible, say what it most likely does and flag the assumption briefly.`;

export const TOOLS_ADDENDUM = `

You may use the Read, Grep and Glob tools to look up definitions elsewhere in the workspace when that materially improves the answer. Keep lookups few and fast.`;

export interface CodeContext {
  relativePath: string;
  languageId: string;
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
  selection: string;
  before: string;
  after: string;
}

export interface Turn {
  question: string;
  answer: string;
}

const MAX_SELECTION_CHARS = 60_000;
const MAX_CONTEXT_CHARS = 20_000;

function fence(code: string): string {
  let ticks = "```";
  while (code.includes(ticks)) ticks += "`";
  return ticks;
}

function block(lang: string, code: string): string {
  const f = fence(code);
  return `${f}${lang}\n${code}\n${f}`;
}

function clip(text: string, max: number, keepEnd: boolean): string {
  if (text.length <= max) return text;
  return keepEnd ? "…\n" + text.slice(text.length - max) : text.slice(0, max) + "\n…";
}

export function buildPrompt(ctx: CodeContext, history: Turn[], question: string): string {
  const parts: string[] = [];
  const range = ctx.startLine === ctx.endLine ? `line ${ctx.startLine}` : `lines ${ctx.startLine}-${ctx.endLine}`;
  parts.push(`File: ${ctx.relativePath} (${ctx.languageId}), selection is ${range}.`);
  if (ctx.before.trim()) {
    parts.push(`Code before the selection:\n${block(ctx.languageId, clip(ctx.before, MAX_CONTEXT_CHARS, true))}`);
  }
  parts.push(`Selected code:\n${block(ctx.languageId, clip(ctx.selection, MAX_SELECTION_CHARS, false))}`);
  if (ctx.after.trim()) {
    parts.push(`Code after the selection:\n${block(ctx.languageId, clip(ctx.after, MAX_CONTEXT_CHARS, false))}`);
  }
  if (history.length) {
    const convo = history.map((t) => `User: ${t.question}\n\nAssistant: ${t.answer}`).join("\n\n---\n\n");
    parts.push(`Earlier in this conversation about the selection:\n\n${convo}`);
  }
  parts.push(`Question about the selected code: ${question}`);
  return parts.join("\n\n");
}
