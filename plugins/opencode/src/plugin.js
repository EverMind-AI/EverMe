/**
 * EverMe memory plugin for OpenCode and Kilo Code (same plugin API: Kilo is
 * an OpenCode fork and its @kilocode/plugin types match @opencode-ai/plugin).
 *
 * Loaded from the host's `plugin` config entry that evercli writes:
 *
 *   ["<config-dir>/everme", { "envFile": "<config-dir>/everme.env", "platform": "opencode" }]
 *
 * A path plugin must default-export `{ id, server }`; the options object is the
 * server function's second argument. There is deliberately no runtime import
 * of @opencode-ai/plugin or @kilocode/plugin, so one bundle loads in both.
 *
 * Hooks used (from @opencode-ai/plugin 1.19.4 Hooks):
 *   experimental.chat.system.transform  profile, once per session's requests
 *   chat.message                        recall, as a synthetic user part
 *   event: session.idle / session.status idle  capture of finished turns
 *
 * Failure policy: injection is best-effort and never blocks a prompt. A
 * capture that fails is not committed, so the next idle retries it; a capture
 * that only timed out is committed, because the gateway stores before it
 * answers.
 */

import { createTranscriptCheckpointStore, recallTag, turnOrdinals } from "@everme/agent-sdk";

import { loadCredentials } from "./credentials.js";
import { partId } from "./ids.js";
import { describeFailure, fetchProfileBlock, fetchRecallBlock, uploadTurns } from "./memory.js";
import { entryKey, lastTurnStart, mapSession, stripSource } from "./transcript.js";

const DISPOSE_WAIT_MS = 10_000;
const IDLE_COALESCE_MS = 2_000;

export function createEvermePlugin(deps = {}) {
  const load = deps.loadCredentials || loadCredentials;
  const profileBlock = deps.fetchProfileBlock || fetchProfileBlock;
  const recallBlock = deps.fetchRecallBlock || fetchRecallBlock;
  const upload = deps.uploadTurns || uploadTurns;
  const idleCoalesceMs = deps.idleCoalesceMs ?? IDLE_COALESCE_MS;

  return async function server(input = {}, options = {}) {
    const client = input.client;
    const log = deps.log || hostLog(client);
    const platform = typeof options.platform === "string" && options.platform ? options.platform : "opencode";
    const credentialsOnce = memoize(() => load(options));
    // Each brand keeps its own checkpoints: an EverMe and an EverOS instance
    // upload the same session, and a shared checkpoint would make one skip
    // the turns the other already sent.
    const stateDir = (typeof options.stateDir === "string" && options.stateDir) || process.env.EVERME_STATE_DIR;
    const store = deps.checkpointStore || createTranscriptCheckpointStore({
      ...(stateDir ? { stateDir } : {}),
    });
    const profiles = new Map();
    const childSessions = new Set();
    const queues = new Map();

    const profileFor = (sessionID) => {
      if (!profiles.has(sessionID)) {
        profiles.set(sessionID, (async () => {
          const credentials = await credentialsOnce();
          if (!credentials.configured) return "";
          try {
            return await profileBlock(credentials);
          } catch (error) {
            log.warn?.(`[everme] ${platform} profile skipped: ${describeFailure(error)}`);
            return "";
          }
        })());
      }
      return profiles.get(sessionID);
    };

    const isChild = async (sessionID) => {
      if (childSessions.has(sessionID)) return true;
      try {
        const res = await client?.session?.get?.({ path: { id: sessionID } });
        const info = res?.data ?? res;
        if (info?.parentID) {
          childSessions.add(sessionID);
          return true;
        }
      } catch {
        // Unknown parentage is treated as a root session: capturing a child
        // twice is recoverable, losing a root turn is not.
      }
      return false;
    };

    const capture = async (sessionID) => {
      const credentials = await credentialsOnce();
      if (!credentials.configured || !sessionID) return;
      if (await isChild(sessionID)) return;
      const res = await client.session.messages({ path: { id: sessionID } });
      const list = Array.isArray(res) ? res : res?.data;
      const { entries, ready } = mapSession(list);
      if (!ready || !entries.length) return;
      const stateId = `${platform}:${sessionID}`;
      await store.withSession(stateId, async () => {
        const checkpoint = await store.read(stateId);
        const seen = new Set(checkpoint.nativeMessageIds || []);
        const fromStart = checkpoint.initialized === true;
        // First sight of a session (a fresh install, or a session the plugin
        // joined mid-way): only its newest turn is uploaded; earlier history is
        // recorded as the excluded baseline, not replayed.
        const start = fromStart ? 0 : lastTurnStart(entries);
        const messages = [];
        const skipped = [];
        let firstIndex = -1;
        for (const [index, entry] of entries.entries()) {
          const key = entryKey(entry);
          if (seen.has(key)) continue;
          seen.add(key);
          if (index < start) {
            skipped.push(key);
            continue;
          }
          if (firstIndex < 0) firstIndex = index;
          messages.push(stripSource(entry));
        }
        if (!messages.length) {
          if (!fromStart && skipped.length) await store.commit(stateId, entries.length, { nativeMessageIds: [...seen] });
          return;
        }
        if (!fromStart && skipped.length) {
          await store.commit(stateId, start, { nativeMessageIds: skipped });
        }
        const addressed = fromStart || firstIndex === 0;
        const userTurns = messages.filter((m) => m.role === "user").length;
        const payload = {
          conversationId: sessionID,
          messages,
          deduplication: "client-native-id",
          ...(addressed ? { baseTurn: turnOrdinals(entries.map(stripSource))[firstIndex], turns: userTurns || 1 } : { turns: 0 }),
        };
        try {
          await upload(credentials, payload, { log });
        } catch (error) {
          if (error?.type !== "timeout") {
            log.warn?.(`[everme] ${platform} capture failed, will retry on next idle: ${describeFailure(error)}`);
            return;
          }
        }
        await store.commit(stateId, entries.length, { nativeMessageIds: [...seen] });
      });
    };

    // Idle can fire again while an upload is still running; captures of one
    // session run one after another so each sees the previous commit.
    // OpenCode 1.19.4 emits both session.status (idle) and session.idle for one
    // transition. The second signal is dropped: in `opencode run` it would
    // query the host after the instance is disposed, which boots a new one.
    const lastIdle = new Map();
    const enqueue = (sessionID) => {
      if (!sessionID) return;
      const now = Date.now();
      if (now - (lastIdle.get(sessionID) ?? -Infinity) < idleCoalesceMs) return queues.get(sessionID);
      lastIdle.set(sessionID, now);
      const previous = queues.get(sessionID) || Promise.resolve();
      const next = previous
        .then(() => capture(sessionID))
        .catch((error) => log.warn?.(`[everme] ${platform} capture skipped: ${describeFailure(error)}`));
      queues.set(sessionID, next);
      return next;
    };

    return {
      // `opencode run` disposes the instance and exits as soon as the session
      // goes idle, while the idle capture is still uploading. Waiting here lets
      // that capture commit its checkpoint; without the commit the next process
      // sees the session as new and the turn ordering is lost.
      dispose: async () => {
        const pending = Promise.allSettled([...queues.values()]);
        let timer;
        await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, DISPOSE_WAIT_MS); })]);
        clearTimeout(timer);
      },

      event: async ({ event } = {}) => {
        const type = event?.type;
        const props = event?.properties || {};
        if (type === "session.created" || type === "session.updated") {
          const info = props.info;
          if (info?.id && info.parentID) childSessions.add(info.id);
          if (type === "session.created" && info?.id && !info.parentID) profileFor(info.id);
          return;
        }
        if (type === "session.idle") return enqueue(props.sessionID);
        if (type === "session.status" && props.status?.type === "idle") return enqueue(props.sessionID);
      },

      "experimental.chat.system.transform": async (hookInput = {}, output = {}) => {
        const sessionID = hookInput.sessionID;
        if (!sessionID || childSessions.has(sessionID) || !Array.isArray(output.system)) return;
        const block = await profileFor(sessionID);
        if (block && !output.system.includes(block)) output.system.push(block);
      },

      "chat.message": async (hookInput = {}, output = {}) => {
        const parts = Array.isArray(output.parts) ? output.parts : null;
        const messageID = output.message?.id || hookInput.messageID;
        if (!parts || !messageID || !hookInput.sessionID) return;
        const prompt = parts
          .filter((part) => part?.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored)
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (!prompt) return;
        const credentials = await credentialsOnce();
        if (!credentials.configured) return;
        const ownTag = `<${recallTag(credentials.brand)}>`;
        if (parts.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.startsWith(ownTag))) return;
        let block = "";
        try {
          block = await recallBlock(credentials, prompt);
        } catch (error) {
          log.warn?.(`[everme] ${platform} recall skipped: ${describeFailure(error)}`);
          return;
        }
        if (!block) return;
        parts.push({
          id: partId(),
          sessionID: hookInput.sessionID,
          messageID,
          type: "text",
          synthetic: true,
          text: block,
        });
      },
    };
  };
}

// Plugins share the host's terminal: console output lands in `opencode run`
// output and garbles the TUI. Lines go to the host's own log file instead.
function hostLog(client) {
  const send = (level) => (message) => {
    try {
      Promise.resolve(client?.app?.log?.({ body: { service: "everme", level, message: String(message) } })).catch(() => {});
    } catch {
      // Logging never fails a hook.
    }
  };
  return { debug: send("debug"), info: send("info"), warn: send("warn"), error: send("error") };
}

function memoize(factory) {
  let promise;
  return () => {
    if (!promise) promise = factory();
    return promise;
  };
}

export const EvermePlugin = createEvermePlugin();

export default { id: "everme", server: EvermePlugin };
