#!/usr/bin/env node
/**
 * UserPromptSubmit hook — recall relevant memories and inject them
 * into Claude's context BEFORE it sees the user's prompt.
 *
 * Hook contract (from Claude Code):
 *   stdin  = JSON { prompt, transcript_path, cwd, ... }
 *   stdout = JSON {
 *     systemMessage: "...",      // shown to user inline
 *     hookSpecificOutput: {
 *       hookEventName: "UserPromptSubmit",
 *       additionalContext: "..." // injected for the model only
 *     }
 *   }
 *
 * On any error or "no relevant memories" we exit 0 silently — never
 * block the user's prompt on a memory backend hiccup.
 */

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));

import { buildMemoryPrompt } from "@everme/agent-sdk";
import { isConfigured } from "./lib/config.js";
import { searchMemories } from "./lib/api.js";
import { redactError, debug } from "./lib/redact.js";

const MIN_PROMPT_WORDS = 3;
const TOP_K = 5;
const MIN_SCORE = 0.1;

async function main() {
  const data = await readStdinJSON();
  const prompt = String(data?.prompt || "");
  if (!isConfigured()) {
    debug("inject", "skip: not configured");
    return process.exit(0);
  }
  if (countTokens(prompt) < MIN_PROMPT_WORDS) {
    debug("inject", "skip: prompt too short");
    return process.exit(0);
  }

  // /mem/search with the gateway's default memoryTypes returns episodes
  // + profiles + raw_messages + agent_memory in a single call, ranked
  // by query relevance. That's strictly more than /mem/context (a
  // queryless full-profile snapshot) — context is kept for SessionStart
  // where there is no prompt, but per-turn inject goes through search.
  let block = "";
  let count = 0;
  let degraded = null;
  try {
    const res = await searchMemories(prompt, { topK: TOP_K });
    // EverOS frequently returns score=null on episodic hits (decoded as
    // 0 over the wire) — that's "unscored", not "score zero". Treat
    // 0/null as unscored and keep the row; only drop rows with an
    // explicit positive score below the threshold.
    const filteredMemories = (res?.memories || []).filter((m) => {
      const s = m?.score ?? m?.relevanceScore;
      return s == null || s === 0 || s >= MIN_SCORE;
    });
    const bundle = {
      memories: filteredMemories,
      profiles: res?.profiles || [],
      rawMessages: res?.rawMessages || [],
      agentMemory: res?.agentMemory || { cases: [], skills: [] },
    };
    count =
      filteredMemories.length +
      bundle.profiles.length +
      (bundle.agentMemory.cases?.length || 0) +
      (bundle.agentMemory.skills?.length || 0) +
      bundle.rawMessages.length;
    // Reuse the SDK renderer so Claude Code and OpenClaw inject the
    // same sectioned shape. wrapInCodeBlock=false because Claude Code
    // wraps the body in an <everme_recall> envelope below — fenced
    // markdown nested in XML reads worse than the bare section list.
    const inner = buildMemoryPrompt(bundle, { wrapInCodeBlock: false });
    if (inner) block = `<everme_recall>\n${inner}\n</everme_recall>`;
  } catch (err) {
    const reason = redactError(err?.message || String(err));
    degraded = reason;
    debug("inject", "search failed:", reason);
  }

  if (!block || count === 0) {
    if (degraded) {
      // Visible single-line WARN — the hook is by design non-blocking,
      // but a fully silent failure means the user thinks EverMe is
      // running while every recall is dropped. Surface it once per
      // hook invocation so persistent issues (expired token, backend
      // unreachable) bubble up without forcing EVERME_DEBUG=1.
      process.stderr.write(`EverMe inject hook degraded: ${degraded}\n`);
    } else {
      debug("inject", "no memories above threshold");
    }
    return process.exit(0);
  }

  const systemMessage = `🧠 Recalling ${count} relevant ${count === 1 ? "memory" : "memories"} from EverMe`;
  const out = {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: block,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

// Multilingual rough word count (CJK characters count individually,
// other languages by whitespace tokens). Mirrors the reference
// plugin's heuristic so users get the same min-prompt feel.
function countTokens(text) {
  if (!text) return 0;
  const cjkRe = /[一-鿿㐀-䶿぀-ゟ゠-ヿ가-힯]/g;
  const cjk = (text.match(cjkRe) || []).length;
  const ascii = text
    .replace(cjkRe, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + ascii;
}

async function readStdinJSON() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

main();
