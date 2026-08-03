import { buildMemoryPrompt } from "../prompt.js";
import { searchMemory } from "../search.js";
import { extractUserIntent, formatQueryStats } from "./query.js";

const MIN_PROMPT_TOKENS = 3;

export async function runInject({ input, client, config, search = searchMemory, log }) {
  const { query, stats } = extractUserIntent(input?.prompt);
  // One line per recall so the host log shows what the framework contributed
  // versus what the user asked. stderr only (stdout is the hook ABI) and
  // lengths only — never the query text.
  writeQueryStats(log, stats);
  if (countTokens(query) < MIN_PROMPT_TOKENS) return { block: "", count: 0 };

  const result = await search(client, { query, topK: config.injectTopK });
  const memories = (result?.memories || []).filter((memory) => {
    const score = memory?.score ?? memory?.relevanceScore;
    return score == null || score === 0 || score >= config.injectMinScore;
  });
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
    cases: true,
    rawMessages: true,
  };
  const inner = buildMemoryPrompt(bundle, { sections });
  if (!inner) return { block: "", count: 0 };

  return {
    block: `<everme_recall>\n${inner}\n</everme_recall>`,
    count: countBundle(bundle, sections),
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

function countBundle(bundle, sections) {
  return (
    (sections.episodes ? bundle.memories.length : 0) +
    (sections.profiles ? bundle.profiles.length : 0) +
    (sections.skills ? bundle.agentMemory?.skills?.length || 0 : 0) +
    (sections.cases ? bundle.agentMemory?.cases?.length || 0 : 0) +
    (sections.rawMessages ? bundle.rawMessages.length : 0)
  );
}
