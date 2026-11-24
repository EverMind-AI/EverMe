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

// Per-row character budgets. Episodes carry the answer body, so they get the
// widest one; every other type keeps the historical width until problems 2 and
// 3 in docs/plugin/research/recall-quality-spec.md settle their own limits.
// server/internal/controller/mcphost/render.go mirrors these — change both.
export const ONE_LINE_MAX_CHARS = 280;
export const EPISODE_MAX_CHARS = 1500;

// Profile budgets. The same profile is rendered by three places that used to
// carry three different numbers (12/6 items at 240/200 chars in the
// SessionStart block, uncapped at 280 in getContext, uncapped at 280 in the Go
// mirror). One pair of constants now backs all of them.
//
// PROFILE_MAX_ITEMS is a backstop, not a selection policy: it is a single
// budget shared by explicit facts and implicit traits, spent facts-first, and
// only bites on a profile far larger than anything observed.
export const PROFILE_MAX_CHARS = 500;
export const PROFILE_MAX_ITEMS = 60;

// Rerank floor below which an agent skill is not rendered at all.
//
// Skill scores come from a cross-encoder and separate cleanly, which the
// earlier "the scale is meaningless" reading missed: measured on a real
// agent, a direct hit scores 0.945-0.999, a tangential one 0.013-0.045, and
// an unrelated one 0.00005-0.002. Nothing at all lands between 0.045 and
// 0.945, so 0.1 sits in the middle of an empty band instead of on an edge —
// 0.05 or 0.9 would select the same rows.
//
// The scorer only ever sees "Agent Skill: {name} - {description}", never the
// body, so this is a coarse pre-filter on whether the TITLE looks relevant.
// Whether the body is actually useful is the host agent's call, made by
// reading it through the skill-body cache.
export const SKILL_MIN_SCORE = 0.1;

// Only the id + name + description of a skill are injected; the body is
// cached locally and fetched by id. Which of these two headers applies is
// decided by the host's declared skillFetch capability, not hedged at render
// time: a host that shows the agent an id and no way to resolve it has made a
// promise it cannot keep, so that host gets neither the id nor the tool name.
const SKILLS_HEADER_FETCH =
  "### Agent skills — summary only; call mem_skill with a skill id for the full text";

// Trailing directive. The skills section sits at the end of a block that can
// run past 2,500 tokens of episodic narrative, and a header instruction that
// far up competes with everything after it. Repeating the call to action as
// the LAST line of the block puts it where recency actually helps, and states
// what the header cannot: that the body is the user's own recorded procedure,
// so following it beats improvising an equivalent one.
// Trailing line. The header sits above what can be 2,500 tokens of episodic
// narrative, so the call to action is repeated where recency helps. One
// sentence, naming the trigger: the task matching a skill, not curiosity.
const SKILLS_FOOTER =
  "If the task at hand matches a skill above, call mem_skill with its id before " +
  "starting: those lines are summaries, the body holds the actual steps.";

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

export function buildMemoryPrompt(memoriesOrBundle, { wrapInCodeBlock = false, sections: requestedSections, skillFetch = false } = {}) {
  // Accept the legacy shape (a bare memories array) and the new
  // searchMemory() bundle ({memories, profiles, rawMessages, agentMemory}).
  // The bundle path renders sub-sections under their own headers so the
  // model can tell an episodic recall apart from a profile trait or a
  // recorded skill — flattening them all under one "Relevant memory"
  // bullet list collapses information the host can act on.
  const bundle = Array.isArray(memoriesOrBundle)
    ? { memories: memoriesOrBundle }
    : memoriesOrBundle || {};

  const enabled = {
    episodes: true,
    profiles: true,
    skills: true,
    rawMessages: true,
    ...requestedSections,
  };
  const sections = [];

  const episodes = (bundle.memories || []).map(formatRow).filter(Boolean);
  if (enabled.episodes && episodes.length) sections.push(["### Episodic memory", ...episodes].join("\n"));

  const profiles = (bundle.profiles || []).map(formatProfile).filter(Boolean);
  if (enabled.profiles && profiles.length) sections.push(["### User profile", ...profiles].join("\n"));

  // Agent cases are deliberately not rendered. Their scores do not separate
  // relevant from irrelevant (an unrelated query still tops out at 0.25-0.29
  // while the second and third rows of a relevant one sit at 0.35-0.53), so
  // no threshold can tell them apart and every turn paid for rows that were
  // noise. The upstream still returns them — EverOS hard-codes the agent-side
  // kinds — but nothing downstream of here spends context on them.
  // Skills render ONLY where the body can be fetched. Without mem_skill the
  // row is a name and a one-line summary of a method the model cannot read:
  // it spends context to advertise a capability it cannot redeem, and invites
  // the model to claim a documented procedure it has never seen. A host that
  // cannot resolve the id is better served by no skill section at all.
  const canFetchSkill = skillFetch === true;
  const skills = canFetchSkill
    ? filterSkillsByScore(bundle.agentMemory?.skills).map(formatSkill).filter(Boolean)
    : [];
  if (enabled.skills && skills.length) {
    sections.push([SKILLS_HEADER_FETCH, ...skills].join("\n"));
  }

  const raw = (bundle.rawMessages || []).map(formatRawMessage).filter(Boolean);
  // Raw rows are unextracted transcript — the header must brand them as
  // provisional so the model never quotes them as established facts.
  // Keep the exact wording in sync with server mcphost/render.go.
  if (enabled.rawMessages && raw.length) sections.push(["### Recent unextracted transcript — provisional, not a stable memory", ...raw].join("\n"));

  if (!sections.length) return "";

  // Appended last, not pushed as a section: it is an instruction about the
  // block, not another kind of memory, and its whole value is being last.
  const trailer = enabled.skills && skills.length ? [SKILLS_FOOTER] : [];
  const body = ["## Relevant memory", ...sections, ...trailer].join("\n\n");
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
  return `- [${label}] ${oneLine(text, EPISODE_MAX_CHARS)}`;
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

/**
 * Drop skills the reranker scored below SKILL_MIN_SCORE.
 *
 * Shared by the renderer and by the skill-body cache so the prompt never
 * carries an id whose body was not kept, and the cache never keeps a body no
 * prompt will reference.
 *
 * A row with no score passes. That is a field-absent defence, not a policy —
 * the same rule filterEpisodesByScore applies — so a gateway that stops
 * sending the field degrades to the old unfiltered behaviour rather than
 * silently rendering nothing.
 *
 * @param {Array} skills rows from searchMemory().agentMemory.skills
 * @param {number} [minScore]
 * @returns {Array} the surviving rows, order preserved
 */
export function filterSkillsByScore(skills, minScore = SKILL_MIN_SCORE) {
  return (skills || []).filter((skill) => {
    const score = skill?.relevanceScore ?? skill?.score;
    return score == null || score >= minScore;
  });
}

function formatSkill(s) {
  if (!s) return "";
  const id = String(s.id || "").trim();
  const name = s.name || "(unnamed skill)";
  // `content` is the skill body and is NOT rendered in either shape: it
  // measured 900-2200 characters per skill, far past any per-row budget. It
  // is cached by id instead (hooks/skill-cache.js) and pulled on demand.
  const desc = s.description || "";
  const head = id ? `- [skill ${id}] ${name}` : `- [skill] ${name}`;
  return desc ? `${head} — ${oneLine(desc)}` : head;
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

function oneLine(s, max = ONE_LINE_MAX_CHARS) {
  return String(s).replace(/\s+/g, " ").trim().slice(0, max);
}
