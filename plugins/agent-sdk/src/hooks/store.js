import { flushAgentMemory, saveAgentMemory } from "../agent-memory.js";
import { completedTurns, turnOrdinals } from "../turns.js";
import { createHookRuntime } from "./runtime-core.js";
import { turnDeliveryEvent } from "./telemetry.js";

export async function runStore({
  input,
  adapter,
  client,
  config,
  counter,
  checkpointStore,
  sessionState,
  stateDir,
  log,
  diagnostic,
  telemetry,
  timestampLedger,
  writeTimeoutMs,
}) {
  const sessionId = input?.sessionId;
  if (!sessionId) {
    log.info?.("[everme] store stage=skip reason=missing_session_id");
    return { block: "", count: 0 };
  }

  // L1-2 is writes{source="hook"} over (writes{source="hook"} + lost_prev).
  // Claiming the hook channel puts a writer in the numerator; running the
  // delivery marker lets it report the denominator's losses. That is ONE
  // decision and it is taken here, from the adapter, before any dispatch.
  //
  // It used to be two: the claim in runStoreBatches gated on turnBoundary,
  // the marker right here gated on nothing. The marker therefore ran before
  // the code knew which path it would take — so a host that never claims the
  // channel still reported losses, and L1-2 divided one population's losses
  // by a different population's writes. Prod read 74.6% of trajectory turns
  // as source="unknown" against 2.9% source="hook": a numerator ~27x too
  // small for the losses being charged to it.
  //
  // A writer whose host does not fire once per logical turn is in NEITHER
  // half — no claim, no marker, no lost_prev.
  const perTurn = adapter?.turnBoundary === "stop";

  // A marker left by the previous invocation is the only durable evidence of
  // a turn killed before its write reached the gateway. Carry that loss as
  // bounded state before reading any transcript data.
  const previous = perTurn && sessionState ? await sessionState.read(sessionId) : {};
  const pending = previous.pendingTurn ?? null;
  const telemetryOn = Boolean(telemetry?.enabled);
  const carried = telemetryOn ? normalizeDebt(previous.lostTurns) : 0;
  const provisionalDebt = telemetryOn && pending ? carried + 1 : carried;
  const provisionalTurnId = input?.turnId || "";
  if (perTurn) await markInFlight(sessionState, sessionId, provisionalTurnId, provisionalDebt);

  const turnId = await resolveTurnId(adapter, input);
  const retryOfPending = Boolean(pending && pending.turnId && pending.turnId === turnId);
  const owed = perTurn
    ? await payDownLosses(telemetry, retryOfPending ? provisionalDebt - 1 : provisionalDebt)
    : 0;
  if (perTurn && (turnId !== provisionalTurnId || owed !== provisionalDebt)) {
    await markInFlight(sessionState, sessionId, turnId, owed);
  }

  if (typeof adapter.readStoreBatches === "function") {
    // read -> upload -> commit has to be atomic per session: hosts that detach
    // the capture hook can run two of these at once for one session, and both
    // would read the same pre-state and upload the same delta. Waiters queue -
    // a second Stop is not necessarily a duplicate, it is just as likely the
    // next turn, and the delta is recomputed from the checkpoint inside the
    // section so ordering them is enough to be correct.
    let result;
    const critical = async () => {
      // `resumeFromStart` tells a checkpointing adapter that an earlier Stop
      // of THIS session started and died before it could commit (the host
      // killed a detached hook, the process crashed, the write never left).
      // That earlier Stop proves the plugin was already running when those
      // turns happened, so a missing checkpoint here is not a first install
      // and the "newest turn only" cold-start rule must not apply: it would
      // drop exactly the turns the dead Stop failed to deliver -- WorkBuddy's
      // first turn of every new session, measured on test 2026-10-16.
      const batches = await adapter.readStoreBatches(input, { checkpointStore, stateDir, resumeFromStart: Boolean(pending) });
      if (!Array.isArray(batches)) return;
      result = await runStoreBatches({
        batches,
        input,
        adapter,
        client,
        config,
        counter,
        checkpointStore,
        sessionState,
        log,
        diagnostic,
        telemetry,
        retryOfPending,
        turnId,
        perTurn,
        timestampLedger,
        writeTimeoutMs,
      });
    };
    if (typeof checkpointStore?.withSession === "function" && input?.sessionId) {
      // A lock ceiling expiry throws rather than running unlocked, and the
      // throw propagates on purpose: the rows stay uncommitted for the next
      // Stop to pick up, and the hook's own handler turns it into one stderr
      // line without failing the turn. Swallowing it here would report a
      // success that never happened.
      await checkpointStore.withSession(`${adapter.platform}:${input.sessionId}`, critical);
    } else {
      await critical();
    }
    if (result !== undefined) return result;
  }
  const messages = await adapter.readLastTurn(input, { stateDir });
  if (!Array.isArray(messages) || !messages.length) {
    log.info?.(`[everme] store stage=skip reason=no_messages sessionId=${logId(sessionId)}`);
    await clearMarker(sessionState, sessionId);
    return { block: "", count: 0 };
  }

  const state = await counter.peek(sessionId, turnId);
  if (state.duplicate) {
    log.info?.(`[everme] store stage=skip reason=duplicate sessionId=${logId(sessionId)} turnId=${logId(turnId)}`);
    await clearMarker(sessionState, sessionId);
    return { block: "", count: 0, duplicate: true };
  }

  const runtime = createHookRuntime({
    // Every write from this path claims the hook channel: the session gate
    // gives a claimed write a ledger row and advances the watermark past its
    // turns, which is what lets the importer's later scan of the same
    // session be trimmed instead of stored a second time. An unclaimed write
    // is anonymous to the gate and every one of its turns re-lands on
    // import (observed on prod for the providers that predate the claim).
    //
    // The declared count is what differs. One Stop = one logical turn on a
    // per-turn host, so it declares 1 even when a long turn is split into
    // several requests. A host whose write events are not 1:1 with turns
    // (devin fires several per answer) declares the user messages the write
    // actually carries: an event that adds no user message completes no
    // turn. Counting per INVOCATION here once declared five turns for a
    // five-tool minimaxcode turn and pushed L1-2 toward 100%.
    //
    // taskBatching rides on both branches: it selects how saveAgentMemory
    // slices the payload, which is independent of the turn declaration.
    enqueue: (turn) => saveAgentMemory(client, {
      ...turn,
      channel: "hook",
      turns: perTurn ? 1 : completedUserTurns(turn.messages),
      taskBatching: adapter.taskBatching === true,
      timestampLedger,
      timeoutMs: writeTimeoutMs,
    }, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId, timeoutMs: writeTimeoutMs }, log),
    diagnostic,
    rethrowOnError: true,
  });
  if (config.flushMode === "legacy") {
    // Legacy mode restores the pre-cadence wire shape exactly: ONE request
    // per turn carrying the messages with flush:true. An add request plus a
    // separate empty flush is NOT equivalent — a flush ACK does not
    // guarantee the extraction was enqueued upstream, so the messages must
    // ride on the flushing request itself.
    const saved = await runtime.flushSession({ conversationId: sessionId, messages });
    await counter.commit(sessionId, turnId, { pendingTurn: null });
    await reportRecovery(telemetry, retryOfPending);
    return { block: "", count: messages.length, flushed: true, status: saved?.status, requestId: saved?.requestId };
  }
  const saved = await writeOrDropMarker(
    () => runtime.enqueueTurn({ conversationId: sessionId, messages }),
    sessionState,
    sessionId,
  );
  // Commit only after the gateway accepted the turn: committing first would
  // consume the turn id on a failed enqueue and dedupe away the retry.
  const committed = await counter.commit(sessionId, turnId, { pendingTurn: null });
  await reportRecovery(telemetry, retryOfPending);
  const flushed = config.flushEveryTurns > 0 && committed.count % config.flushEveryTurns === 0;
  let requestId = saved?.requestId;
  if (flushed) {
    const flushRes = await runtime.flush(sessionId);
    requestId = flushRes?.requestId || requestId;
  }
  return { block: "", count: messages.length, flushed, requestId };
}

async function runStoreBatches({
  batches,
  input,
  adapter,
  client,
  config,
  counter,
  checkpointStore,
  sessionState,
  log,
  diagnostic,
  telemetry,
  retryOfPending,
  turnId,
  perTurn,
  timestampLedger,
  writeTimeoutMs,
}) {
  const ready = batches.filter((batch) => (
    batch
    && typeof batch.conversationId === "string"
    && batch.conversationId
    && Array.isArray(batch.messages)
    && batch.messages.length
  ));
  if (!ready.length) {
    log.info?.(`[everme] store stage=skip reason=no_ready_batches sessionId=${logId(input?.sessionId)} inputBatches=${Array.isArray(batches) ? batches.length : 0}`);
    await clearMarker(sessionState, input?.sessionId);
    return { block: "", count: 0 };
  }

  const turn = await counter.peek(input.sessionId, turnId);
  const runtime = createHookRuntime({
    enqueue: (batch) => saveAgentMemory(client, {
      ...batch,
      taskBatching: adapter.taskBatching === true,
      timestampLedger,
      timeoutMs: writeTimeoutMs,
    }, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId, timeoutMs: writeTimeoutMs }, log),
    diagnostic,
    rethrowOnError: true,
  });
  let requestId;
  let status;
  let count = 0;

  // perTurn arrives from runStore, which is also where the delivery marker is
  // gated on it — one flag, two halves, so the claim and the loss reporter
  // cannot drift apart again. Whole-session hosts ride this same path
  // (kimicode uploads the root session at SessionEnd) and stay unclaimed, and
  // now report no losses either. One Stop may split into several checkpoint
  // batches; the turn is declared once, on the last of them.
  for (const [index, batch] of ready.entries()) {
    // Defaults first in intent, but the channel claim is not negotiable: the
    // monitoring gate reads it. An adapter may declare the turn count itself
    // (0 for a cold-start tail that must not move the watermark, or several at
    // once -- qwenwork's checkpoint delta rescues many turns in one write and
    // says so); anything that is not an integer falls back to the Stop's
    // single turn riding on the last batch.
    const payload = perTurn
      ? { ...batch, channel: "hook", turns: Number.isInteger(batch.turns) ? batch.turns : (index === ready.length - 1 ? 1 : 0) }
      : batch;
    const saved = await writeOrDropMarker(
      () => (config.flushMode === "legacy" ? runtime.flushSession(payload) : runtime.enqueueTurn(payload)),
      sessionState,
      input?.sessionId,
    );
    requestId = saved?.requestId || requestId;
    status = saved?.status || status;
    count += batch.messages.length;
    if (batch.checkpoint && checkpointStore) {
      await checkpointStore.commit(batch.checkpoint.stateId, batch.checkpoint.uploadedCount, batch.checkpoint);
    }
  }

  let committed = { count: turn.count };
  if (turn.duplicate) {
    await clearMarker(sessionState, input.sessionId);
  } else {
    committed = await counter.commit(input.sessionId, turnId, { pendingTurn: null });
  }
  await reportRecovery(telemetry, retryOfPending);
  if (config.flushMode === "legacy") {
    return { block: "", count, flushed: true, status, requestId };
  }

  const flushed = config.flushEveryTurns > 0 && committed.count % config.flushEveryTurns === 0;
  if (flushed) {
    for (const conversationId of new Set(ready.map((batch) => batch.conversationId))) {
      const flushRes = await runtime.flush(conversationId);
      requestId = flushRes?.requestId || requestId;
    }
  }
  return { block: "", count, flushed, requestId };
}

// A turn that landed on the first attempt reports nothing: the write itself
// is the record. Only a turn that previously failed and has now been replayed
// is worth a report, because its earlier attempt was already counted as a
// loss and the recovery has to cancel it out.
async function reportRecovery(telemetry, retryOfPending) {
  if (!retryOfPending) return;
  await telemetry?.report(turnDeliveryEvent({ outcome: "recovered" }));
}

/**
 * Reports at most ONE loss and returns what is still owed.
 *
 * The marker used to be cleared before the report was attempted, so a report
 * that timed out took the only evidence of that turn with it - completeness
 * read highest exactly during the outage that was destroying it. The debt now
 * survives in session state and drains on later turns.
 *
 * One report per turn, but the debt itself is NOT capped: it is a single
 * integer, so a backlog of ten and a backlog of ten thousand cost the state
 * file the same bytes, and truncating it would under-report losses in exactly
 * the incident that produced them. What is bounded is the per-turn cost -
 * draining N losses serially would put the hook N request timeouts over its
 * budget.
 */
async function payDownLosses(telemetry, owed) {
  if (owed <= 0) return 0;
  if (await telemetry?.report(turnDeliveryEvent({ outcome: "lost_prev" }))) return owed - 1;
  return owed;
}

function normalizeDebt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function markInFlight(sessionState, sessionId, turnId, lostTurns) {
  if (!sessionState) return;
  await sessionState.patch(sessionId, {
    pendingTurn: { startedAt: Date.now(), turnId },
    lostTurns: normalizeDebt(lostTurns),
  });
}

// A gateway refusal of the credential is not a delivery loss. The write and
// the loss report that would follow it ride the same evt, so carrying a
// refusal as turn debt dumps the whole credential outage onto L1-2 later — as
// one lost_prev spike the moment the credential is fixed, blaming capture
// completeness for a credential problem after the fact. Drop the marker and
// let the error propagate: the host still sees the failure, and the refusal is
// already counted server-side by the memauth metric.
//
// Anything else propagates with the marker intact, so the next turn reports
// it as the delivery loss it is.
async function writeOrDropMarker(operation, sessionState, sessionId) {
  try {
    return await operation();
  } catch (error) {
    if (error?.type === "auth") await clearMarker(sessionState, sessionId);
    throw error;
  }
}

async function clearMarker(sessionState, sessionId) {
  if (!sessionState) return;
  await sessionState.patch(sessionId, { pendingTurn: null });
}

// Hosts whose Stop payload carries no native turn id (Claude Code's
// documented Stop stdin has none) can expose resolveTurnId to derive a
// stable per-turn key from what they do have (e.g. the transcript's last
// event uuid). An empty result keeps the existing contract: empty turnId
// disables dedup for hosts with no better key.
async function resolveTurnId(adapter, input) {
  if (input?.turnId) return input.turnId;
  if (typeof adapter?.resolveTurnId !== "function") return "";
  return (await adapter.resolveTurnId(input)) || "";
}

function logId(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 128 ? `${text.slice(0, 128)}…` : text;
}

export async function runBoundaryFlush({
  input,
  adapter,
  client,
  sessionState,
  checkpointStore,
  stateDir,
  log,
  diagnostic,
  timestampLedger,
  writeTimeoutMs,
}) {
  if (!input?.sessionId) {
    log.info?.("[everme] boundary-flush stage=skip reason=missing_session_id");
    return { block: "", count: 0 };
  }
  // Whole-session hosts claim the hook channel too. This path used to stay
  // unclaimed so that hosts without a delivery marker would not enter
  // L1-2's denominator; the price was that the session gate never saw their
  // writes, and the importer re-landed every turn they had uploaded
  // (kimicode, minimaxcode on prod). The claim wins: L1-2 is read per host
  // anyway, and dedupe is not negotiable. Each write carries absolute turn
  // coordinates where the adapter can derive them (a checkpointed delta of a
  // transcript it can read whole) and otherwise declares the turns it
  // completes for the gate's append fallback.
  const runtime = createHookRuntime({
    enqueue: (turn) => saveAgentMemory(client, {
      ...turn,
      channel: "hook",
      ...(Number.isInteger(turn.turns) ? {} : { turns: completedUserTurns(turn.messages) }),
      taskBatching: adapter.taskBatching === true,
      timestampLedger,
      timeoutMs: writeTimeoutMs,
    }, log),
    flush: (conversationId) => flushAgentMemory(client, { conversationId, timeoutMs: writeTimeoutMs }, log),
    diagnostic,
    rethrowOnError: true,
  });
  if (typeof adapter?.readSessionBatches === "function") {
    const batches = await adapter.readSessionBatches(input, { checkpointStore, stateDir });
    if (Array.isArray(batches)) {
      const ready = batches.filter((batch) => (
        batch
        && typeof batch.conversationId === "string"
        && batch.conversationId
        && Array.isArray(batch.messages)
        && batch.messages.length
      ));
      if (!ready.length) return { block: "", count: 0, skipped: true };
      let count = 0;
      let requestId;
      for (const batch of ready) {
        const saved = await runtime.flushSession(batch);
        requestId = saved?.requestId || requestId;
        count += batch.messages.length;
        if (batch.checkpoint && checkpointStore) {
          await checkpointStore.commit(batch.checkpoint.stateId, batch.checkpoint.uploadedCount);
        }
      }
      return { block: "", count, flushed: true, requestId };
    }
  }
  if (typeof adapter?.readSession === "function") {
    // Whole-session hosts (kimi-code) register no per-turn Stop writer, so
    // the boundary is their single write and must carry every turn itself.
    const messages = await adapter.readSession(input);
    if (!Array.isArray(messages) || !messages.length) return { block: "", count: 0 };
    // High-water mark: SessionEnd can fire more than once for the same
    // session (re-fired boundary, resumed session ending again). Upload only
    // the messages past what a previous boundary already uploaded, and
    // advance the marker only after the upload succeeded. With no new
    // messages we skip entirely — no bare flush: the previous successful
    // upload already flushed, and a flush ACK does not guarantee extraction
    // enqueue upstream, so a bare re-flush adds noise without recovery value.
    const uploadedCount = sessionState ? (await sessionState.read(input.sessionId)).uploadedCount : 0;
    const delta = uploadedCount > 0 ? messages.slice(uploadedCount) : messages;
    if (!delta.length) return { block: "", count: 0, skipped: true };
    // The whole transcript is in hand, so the delta is addressed by absolute
    // turn: the ordinal of its first message, and the turns it completes
    // (a trailing unanswered user message is not one of them).
    const baseTurn = uploadedCount > 0 ? turnOrdinals(messages)[uploadedCount] : 0;
    const turns = completedTurns([delta], 0, baseTurn);
    // Hosts whose boundary fires per TURN rather than once per session opt
    // out of the flush: a flushing write waits for the upstream extraction
    // (measured 29.8s against a real backend versus 0.9s for the same
    // payload without it), which on a per-turn boundary means every turn
    // blocks past the hook budget and reports a failure it never suffered.
    // The gateway promotes an un-flushed session on its own, so the only
    // thing given up is knowing WHEN that happened. Hosts whose boundary is
    // genuinely once-per-session (kimi-code) keep flushing: for them this is
    // the single write of the session and the wait happens once.
    const saved = adapter?.boundaryFlush === false
      ? await runtime.enqueueTurn({ conversationId: input.sessionId, messages: delta, baseTurn, turns })
      : await runtime.flushSession({ conversationId: input.sessionId, messages: delta, baseTurn, turns });
    // The high-water mark tracks UPLOAD dedup, not extraction: the gateway
    // accepted these messages, so re-sending them next boundary would
    // double-write. Extraction state travels separately via `status` —
    // "no_extraction" here means the upstream queued the session without
    // materialising it yet (v2 first-flush gap).
    if (sessionState) await sessionState.patch(input.sessionId, { uploadedCount: messages.length });
    return {
      block: "",
      count: delta.length,
      flushed: adapter?.boundaryFlush !== false,
      status: saved?.status,
      requestId: saved?.requestId,
    };
  }
  const flushRes = await runtime.onSessionEnd(input.sessionId);
  return { block: "", count: 0, flushed: true, requestId: flushRes?.requestId };
}

// completedUserTurns is the turn declaration for a write without absolute
// coordinates: each user message it carries opens a turn the host has since
// answered, so that count is what the write completes. Zero is legitimate
// (a tool-only follow-up) and advances nothing.
function completedUserTurns(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((message) => message?.role === "user").length;
}
