import { buildMemoryPrompt, filterSkillsByScore } from "../prompt.js";
import { filterEpisodesByScore, searchMemory } from "../search.js";
import { extractUserIntent, formatQueryStats } from "./query.js";
import { recallTag } from "../brand.js";

const MIN_PROMPT_TOKENS = 3;

export async function runInject({ input, client, config, search = searchMemory, log }) {
  const { query, stats } = extractUserIntent(input?.prompt);
  // One line per recall so the host log shows what the framework contributed
  // versus what the user asked. stderr only (stdout is the hook ABI) and
  // lengths only — never the query text.
  writeQueryStats(log, stats);
  if (countTokens(query) < MIN_PROMPT_TOKENS) return { block: "", count: 0 };

  const result = await search(client, { query, topK: config.injectTopK, skillFetch: config.skillFetch }, log);
  // Shared with OpenClaw's assemble — see filterEpisodesByScore for why a
  // literal 0 is rejected while a missing score passes.
  const memories = filterEpisodesByScore(result?.memories, config.injectMinScore);
  const bundle = {
    memories,
    profiles: result?.profiles || [],
    rawMessages: result?.rawMessages || [],
    agentMemory: result?.agentMemory || { cases: [], skills: [] },
  };
  const sections = {
    episodes: true,
    profiles: config.injectProfile,
    skills: true,
    rawMessages: true,
  };
  const inner = buildMemoryPrompt(bundle, { sections, skillFetch: config.skillFetch });
  if (!inner) return { block: "", count: 0 };

  return {
    block: `<${recallTag(config.brand)}>\n${inner}\n</${recallTag(config.brand)}>`,
    count: countBundle(bundle, sections, config.skillFetch === true),
  };
}

// writeQueryStats emits the recall-query line. The hook contract owns stdout,
// so this goes to stderr (where every host already collects diagnostics) and
// stays a single line the operator can grep for.
function writeQueryStats(log, stats) {
  const line = `[everme] recall query: ${formatQueryStats(stats)}`;
  if (typeof log?.info === "function") {
    log.info(line);
    return;
  }
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // A closed stderr must never break recall.
  }
}

function countTokens(text) {
  if (!text) return 0;
  const cjkPattern = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkCount = (text.match(cjkPattern) || []).length;
  const otherCount = text.replace(cjkPattern, " ").split(/\s+/).filter(Boolean).length;
  return cjkCount + otherCount;
}

// Counts what the block actually carries, so the number the host logs and
// the rows the model sees cannot disagree: cases are never rendered, and
// skills are counted only under the same score filter AND the same host
// capability gate the renderer applies.
function countBundle(bundle, sections, skillFetch) {
  return (
    (sections.episodes ? bundle.memories.length : 0) +
    (sections.profiles ? bundle.profiles.length : 0) +
    (sections.skills && skillFetch ? filterSkillsByScore(bundle.agentMemory?.skills).length : 0) +
    (sections.rawMessages ? bundle.rawMessages.length : 0)
  );
}
