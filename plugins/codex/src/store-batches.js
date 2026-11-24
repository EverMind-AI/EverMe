import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { readCanonicalTranscript, readLastTurn } from "./transcript.js";
import { turnOrdinals } from "@everme/agent-sdk";
import { readFragmentScope } from "./fragment.js";

export async function readCodexStoreBatches(input, { checkpointStore, resumeFromStart = false, diagnostic = () => {} } = {}) {
  if (!input?.sessionId || !input?.transcriptPath) return [];
  const batches = [];
  const root = await transcriptBatch({
    checkpointStore,
    diagnostic,
    conversationId: input.sessionId,
    // A failed earlier Stop of this session (resumeFromStart) means the
    // older turns are this hook's own, not history from before the install.
    initialTailOnly: !resumeFromStart,
    transcriptPath: input.transcriptPath,
  });
  if (root) batches.push(root);

  for (const child of await completedDescendants(input.transcriptPath, input.sessionId)) {
    const batch = await transcriptBatch({
      checkpointStore,
      diagnostic,
      conversationId: child.id,
      initialTailOnly: false,
      transcriptPath: child.path,
    });
    if (batch) batches.push(batch);
  }
  return batches;
}

async function transcriptBatch({ checkpointStore, conversationId, initialTailOnly, transcriptPath, diagnostic }) {
  const canonical = await readCanonicalTranscript(transcriptPath, { diagnostic });
  if (!canonical.length) return null;
  const syncScope = await readFragmentScope(transcriptPath);
  const stateId = syncScope ? `codex:${conversationId}:${syncScope}` : `codex:${conversationId}`;
  const checkpoint = checkpointStore
    ? await checkpointStore.read(stateId)
    : { initialized: false, uploadedCount: 0 };
  const continuation = checkpoint.initialized && checkpoint.uploadedCount <= canonical.length;
  const messages = continuation
    ? canonical.slice(checkpoint.uploadedCount)
    : (initialTailOnly ? await readLastTurn(transcriptPath) : canonical);
  if (!messages.length) return null;
  return {
    conversationId,
    ...(syncScope ? { syncScope } : {}),
    messages,
    // Address by absolute turn only when everything before the slice is
    // known to be covered: a checkpoint continuation, or the whole canonical
    // transcript. A cold-start tail must not claim the turns it skipped, or
    // the importer would trim the history it still has to bring in; left
    // unaddressed, the gate appends it at the current watermark instead.
    ...((continuation || messages.length === canonical.length) && messages.length <= canonical.length
      ? { baseTurn: turnOrdinals(canonical)[canonical.length - messages.length] }
      // A cold-start tail declares no completed turn either, so the gate
      // neither positions nor appends it (see the claude-code adapter).
      : { turns: 0 }),
    checkpoint: { stateId, uploadedCount: canonical.length },
  };
}

async function completedDescendants(rootPath, rootId) {
  let names;
  try {
    names = await readdir(path.dirname(rootPath));
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const candidatePath = path.join(path.dirname(rootPath), name);
    if (candidatePath === rootPath) continue;
    const metadata = await rolloutMetadata(candidatePath);
    if (metadata?.isSubagent && metadata.complete) {
      candidates.push({ ...metadata, path: candidatePath });
    }
  }

  const descendants = [];
  const parents = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (candidate.selected || !parents.has(candidate.parentId)) continue;
      candidate.selected = true;
      parents.add(candidate.id);
      descendants.push(candidate);
      changed = true;
    }
  }
  return descendants;
}

async function rolloutMetadata(transcriptPath) {
  let raw;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }
  let metadata;
  let complete = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!metadata && event?.type === "session_meta") {
      const payload = event.payload || {};
      const id = stringValue(payload.id || payload.session_id);
      const parentId = stringValue(payload.parent_thread_id || payload.forked_from_id);
      metadata = {
        id,
        parentId,
        isSubagent: payload.thread_source === "subagent" || Boolean(parentId),
      };
    }
    if ((event?.type === "event_msg" && event?.payload?.type === "task_complete")
      || event?.type === "task_complete") {
      complete = true;
    }
  }
  if (!metadata?.id || !metadata.parentId) return null;
  return { ...metadata, complete };
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}
