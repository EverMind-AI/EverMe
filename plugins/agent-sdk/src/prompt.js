/**
 * Renders a list of memory rows into a single context block to prepend
 * onto the system prompt.
 *
 * Output shape (markdown, wrapped in a fenced block):
 *
 *   ```memory
 *   ## Relevant memory
 *   - [episodic] User asked X on 2026-04-20. Resolved by Y.
 *   - [profile] Prefers Go; avoids JS for backend.
 *   ```
 *
 * The wrapping fence is optional (wrapInCodeBlock) — OpenClaw needs the
 * fence so the host can reliably extract or strip it; MCP responses
 * usually don't.
 */

export const MEMORY_TYPES = Object.freeze({
  EPISODIC: "episodic",
  EPISODIC_MEMORY: "episodic_memory",
  PROFILE: "profile",
  AGENT_MEMORY: "agent_memory",
  RAW_MESSAGE: "raw_message",
});

export const MEMORY_TYPE_LABELS = Object.freeze({
  [MEMORY_TYPES.EPISODIC]: "episodic",
  [MEMORY_TYPES.EPISODIC_MEMORY]: "episodic",
  [MEMORY_TYPES.PROFILE]: "profile",
  [MEMORY_TYPES.AGENT_MEMORY]: "agent",
  [MEMORY_TYPES.RAW_MESSAGE]: "recent",
});

export function buildMemoryPrompt(memoriesOrBundle, { wrapInCodeBlock = false } = {}) {
  // Accept the legacy shape (a bare memories array) and the new
  // searchMemory() bundle ({memories, profiles, rawMessages, agentMemory}).
  // The bundle path renders sub-sections under their own headers so the
  // model can tell an episodic recall apart from a profile trait or a
  // recorded skill — flattening them all under one "Relevant memory"
  // bullet list collapses information the host can act on.
  const bundle = Array.isArray(memoriesOrBundle)
    ? { memories: memoriesOrBundle }
    : memoriesOrBundle || {};

  const sections = [];

  const episodes = (bundle.memories || []).map(formatRow).filter(Boolean);
  if (episodes.length) sections.push(["### Episodic memory", ...episodes].join("\n"));

  const profiles = (bundle.profiles || []).map(formatProfile).filter(Boolean);
  if (profiles.length) sections.push(["### User profile", ...profiles].join("\n"));

  const skills = (bundle.agentMemory?.skills || []).map(formatSkill).filter(Boolean);
  if (skills.length) sections.push(["### Agent skills", ...skills].join("\n"));

  const cases = (bundle.agentMemory?.cases || []).map(formatCase).filter(Boolean);
  if (cases.length) sections.push(["### Past task cases", ...cases].join("\n"));

  const raw = (bundle.rawMessages || []).map(formatRawMessage).filter(Boolean);
  if (raw.length) sections.push(["### Recent raw messages", ...raw].join("\n"));

  if (!sections.length) return "";

  const body = ["## Relevant memory", ...sections].join("\n\n");
  return wrapInCodeBlock ? "```memory\n" + body + "\n```" : body;
}

function formatRow(m) {
  if (!m) return "";
  const label = MEMORY_TYPE_LABELS[m.type] || m.type || "memory";
  // EverMe /mem/search items carry the narrated form under `episode`.
  // `foresight` is forward-looking (what the user *will* want) and
  // not the body, so it doesn't belong in the fallback chain.
  const text = m.episode || m.summary || m.content || m.text || "";
  if (!text) return "";
  return `- [${label}] ${oneLine(text)}`;
}

function formatProfile(p) {
  if (!p) return "";
  // The EverMe gateway returns the opaque EverOS profileData map as-is.
  // EverOS keeps embed_text / item_type snake_case inside that map —
  // those are NOT our wire fields and stay verbatim.
  const data = p.profileData || {};
  const text = data.embed_text || p.summary || "";
  if (!text) return "";
  const tag = data.item_type || "profile";
  return `- [${tag}] ${oneLine(text)}`;
}

function formatSkill(s) {
  if (!s) return "";
  const name = s.name || "(unnamed skill)";
  const desc = s.description || s.content || "";
  const head = `- [skill] ${name}`;
  return desc ? `${head} — ${oneLine(desc)}` : head;
}

function formatCase(c) {
  if (!c) return "";
  const intent = c.taskIntent || "";
  const approach = c.approach || "";
  if (!intent && !approach) return "";
  const head = intent ? `- [case] ${oneLine(intent)}` : "- [case]";
  return approach ? `${head} — ${oneLine(approach)}` : head;
}

function formatRawMessage(m) {
  if (!m) return "";
  // raw_messages.contentItems is an opaque parts array (text, tool calls,
  // attachments...). Best-effort: stringify text-like parts and keep one
  // line per message so the block stays readable in-prompt. We only
  // surface senderName when present — senderId is an opaque internal id
  // that would leak into the prompt as noise.
  const sender = m.senderName || "speaker";
  const text = rawMessageText(m.contentItems);
  if (!text) return "";
  return `- [raw ${sender}] ${oneLine(text)}`;
}

function rawMessageText(parts) {
  if (!Array.isArray(parts)) return "";
  const chunks = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === "string") {
      chunks.push(p);
      continue;
    }
    if (typeof p.text === "string") {
      chunks.push(p.text);
      continue;
    }
    if (typeof p.content === "string") {
      chunks.push(p.content);
    }
  }
  return chunks.join(" ");
}

function oneLine(s) {
  return String(s).replace(/\s+/g, " ").trim().slice(0, 280);
}
