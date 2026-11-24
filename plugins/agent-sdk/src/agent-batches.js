const TURN_BOUNDARY = 2;
const TOOL_BOUNDARY = 1;

export function batchAgentMessages(messages, maxMessages, metadata = [], alignTails = false) {
  const boundaries = classifyBoundaries(messages, metadata);
  const batches = [];
  for (let start = 0; start < messages.length;) {
    const limit = Math.min(start + maxMessages, messages.length);
    let end = limit === messages.length ? limit : chooseBoundary(boundaries, start, limit);
    if (alignTails && start > 0 && messages[start]?.role !== "user") {
      for (let next = start + 1; next < end; next += 1) {
        if (messages[next]?.role === "user") {
          end = next;
          break;
        }
      }
    }
    batches.push(messages.slice(start, end));
    start = end;
  }
  return batches;
}

function classifyBoundaries(messages, metadata) {
  const boundaries = new Array(messages.length + 1).fill(0);
  const pending = new Map();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    for (const call of message.toolCalls || []) {
      pending.set(call.id, (pending.get(call.id) || 0) + 1);
    }
    const matched = matchResult(messages, index, pending);
    if (pending.size !== 0) continue;
    if (isTurnEnd(messages, metadata, index)) {
      boundaries[index + 1] = TURN_BOUNDARY;
    } else if (matched) {
      boundaries[index + 1] = TOOL_BOUNDARY;
    }
  }
  return boundaries;
}

function matchResult(messages, index, pending) {
  const message = messages[index];
  const count = pending.get(message.toolCallId);
  if (message.role !== "tool" || !count) return false;
  const next = messages[index + 1];
  if (next?.role === "tool" && next.toolCallId === message.toolCallId) return false;
  if (count === 1) pending.delete(message.toolCallId);
  else pending.set(message.toolCallId, count - 1);
  return true;
}

function isTurnEnd(messages, metadata, index) {
  const message = messages[index];
  if (message.role !== "assistant" || message.toolCalls?.length) return false;
  const current = metadata[index];
  const next = metadata[index + 1];
  if (current?.turnComplete === false) return false;
  return current?.turnComplete === true
    || messages[index + 1]?.role === "user"
    || Boolean(current?.turnId && next?.turnId && current.turnId !== next.turnId);
}

function chooseBoundary(boundaries, start, limit) {
  for (const kind of [TURN_BOUNDARY, TOOL_BOUNDARY]) {
    for (let end = limit; end > start; end -= 1) {
      if (boundaries[end] === kind) return end;
    }
  }
  return limit;
}
