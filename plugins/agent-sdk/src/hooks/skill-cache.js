/**
 * Local cache for agent-skill bodies, keyed by skill id.
 *
 * The injected block only carries id + name + description (see formatSkill in
 * ../prompt.js): a skill body measured 900-2200 characters on a real agent,
 * so injecting every retrieved one costs more context than the whole rest of
 * the block. The body is nevertheless already in the /mem/search response —
 * transport is paid for — so it is written here and read back by id when the
 * host agent decides one is worth opening.
 *
 * There is no server-side way to fetch a skill by id: the EverOS filter set
 * has no `id` field and the gateway exposes no get endpoint. Local is not a
 * shortcut, it is the only route.
 *
 * The directory is the SHARED hook state dir (~/.everme/state unless
 * EVERME_STATE_DIR overrides it), which is what makes this work at all: the
 * hook process writes during recall and a separate MCP process reads later.
 * Both resolve the same default with no extra configuration. Files are
 * `<id>.skill.json`, so the existing pruneStaleStateFiles sweep already
 * expires them along with every other `.json` in that directory.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_STATE_DIR,
  pruneStaleStateFiles,
  sanitizeSessionId,
  writeState,
} from "./state.js";

const SKILL_FILE_SUFFIX = ".skill.json";

function defaultStateDir() {
  // Read at call time, not module load: hosts set EVERME_STATE_DIR per
  // process and tests point it at a temp directory.
  return process.env.EVERME_STATE_DIR || DEFAULT_STATE_DIR;
}

export function createSkillContentCache({ stateDir } = {}) {
  const dirOf = () => stateDir || defaultStateDir();
  const fileFor = (id) => path.join(dirOf(), `${sanitizeSessionId(id)}${SKILL_FILE_SUFFIX}`);

  return {
    /**
     * Persist the bodies of `skills`. Callers pass rows that already cleared
     * SKILL_MIN_SCORE — a skill too weak to be rendered carries no id into the
     * prompt, so caching it would only be dead weight.
     *
     * @returns {Promise<number>} how many bodies were written
     */
    async write(skills) {
      const rows = (skills || []).filter((skill) => skill?.id && skill?.content);
      if (!rows.length) return 0;
      const dir = dirOf();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let written = 0;
      let lastFile = "";
      for (const skill of rows) {
        const file = fileFor(skill.id);
        try {
          await writeState(file, {
            id: String(skill.id),
            name: String(skill.name || ""),
            description: String(skill.description || ""),
            content: String(skill.content),
            cachedAt: new Date().toISOString(),
          });
          written += 1;
          lastFile = file;
        } catch {
          // One unwritable body must not cost the others, and none of them
          // may cost the recall this rode in on.
        }
      }
      // Same sweep every other state write triggers — skills expire on the
      // shared STATE_MAX_AGE_MS rather than on a second, private policy.
      await pruneStaleStateFiles(dir, lastFile);
      return written;
    },

    /**
     * @returns {Promise<{id, name, description, content, cachedAt}|null>}
     *          null when this id was never cached or the file is unreadable.
     *          A miss is reported as a miss; there is no substitute body to
     *          serve in its place.
     */
    async read(id) {
      const key = String(id || "").trim();
      if (!key) return null;
      try {
        const parsed = JSON.parse(await readFile(fileFor(key), "utf8"));
        if (typeof parsed?.content !== "string" || !parsed.content) return null;
        return {
          id: typeof parsed.id === "string" ? parsed.id : key,
          name: typeof parsed.name === "string" ? parsed.name : "",
          description: typeof parsed.description === "string" ? parsed.description : "",
          content: parsed.content,
          cachedAt: typeof parsed.cachedAt === "string" ? parsed.cachedAt : "",
        };
      } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        return null;
      }
    },
  };
}

/**
 * Best-effort write used on the retrieval path. Recall must never fail
 * because a cache file could not be written, so every error is swallowed
 * here — the consequence of a failed write is a later cache miss, which the
 * read tool reports honestly.
 */
export async function cacheSkillContent(skills, options) {
  try {
    return await createSkillContentCache(options).write(skills);
  } catch {
    return 0;
  }
}
