/**
 * Whole-turn coordinates for the gateway's session gate.
 *
 * A role=user message opens a turn; messages before the first user message
 * ride with turn 0. The gate trims and advances its watermark in these units,
 * and the Go importer (cli/internal/importer/conversation, messageTurnOrdinals
 * / batchAgentMessages / completedTurns) labels the same transcripts with the
 * same rules, so a hook and an import of one session agree on every ordinal.
 * Keep the three functions below in lockstep with their Go twins.
 */

const USER = "user";

// turnOrdinals assigns each message its 0-based turn ordinal within messages.
export function turnOrdinals(messages) {
  const out = new Array(messages.length);
  let ordinal = 0;
  let seenUser = false;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === USER) {
      if (seenUser) ordinal += 1;
      seenUser = true;
    }
    out[i] = ordinal;
  }
  return out;
}

// splitTurnAligned cuts messages into slices of at most max messages that the
// gate's coordinates can address: a slice begins at a user message, or -- when
// one turn alone exceeds max -- as a pure tail of the previous slice's last
// turn, which is closed before the next user message so it never opens a
// turn of its own.
export function splitTurnAligned(messages, max) {
  const slices = [];
  let cur = [];
  let curIsTail = false;
  for (const message of messages) {
    const isUser = message?.role === USER;
    if (cur.length && (cur.length >= max || (isUser && curIsTail))) {
      slices.push(cur);
      cur = [];
      curIsTail = !isUser;
    }
    cur.push(message);
  }
  if (cur.length) slices.push(cur);
  return slices;
}

// completedTurns is how many whole turns slice i of slices completes, the
// count the gate advances its turn watermark by. User messages open turns. A
// slice that begins mid-turn closes the turn left open before it -- within an
// upload that is the previous slice's; for the first slice it is the previous
// upload's, which only exists past turn 0 (at turn 0 leading non-user
// messages are opening context). A turn still open when the slice ends is not
// counted: the next slice continues it, or the upload ends on a bare user
// message whose answer is not there yet.
export function completedTurns(slices, i, baseTurn) {
  const slice = slices[i];
  if (!Array.isArray(slice) || !slice.length) return 0;
  let n = slice.filter((message) => message?.role === USER).length;
  if (slice[0]?.role !== USER && (i > 0 || baseTurn > 0)) n += 1;
  if (i < slices.length - 1) {
    if (slices[i + 1]?.[0]?.role !== USER) n -= 1;
  } else if (slice[slice.length - 1]?.role === USER) {
    n -= 1;
  }
  return n < 0 ? 0 : n;
}
