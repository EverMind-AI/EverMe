/**
 * Drop tool calls the gateway would reject, and the results that pair to them.
 *
 * This is a wire rule, not a host quirk: /mem/agent-memory validates a call's
 * name and parses its arguments as JSON, so a host transcript carrying either
 * malformed sinks the whole batch. It mirrors filterInvalidToolCalls in
 * cli/internal/importer/conversation/tool_calls.go, which applies the same rule
 * on the cold-start path — the two must agree or the same session uploads
 * differently depending on which channel carried it.
 *
 * Nothing is repaired. A missing name is not guessed and empty arguments are
 * not rewritten to "{}": inventing either would state a call the source does
 * not.
 */

const REASONS = ["invalid_tool_name", "invalid_tool_arguments"];

/**
 * @param {Array<object>} messages agent-memory messages, in order
 * @param {{platform?: string}} [options] host label for the dropped-count warning
 * @returns {Array<object>} the same array when nothing was invalid, else a copy
 */
export function filterInvalidTools(messages, { platform = "" } = {}) {
  const counts = new Map();
  const invalid = new Map();
  const reasons = new Map();
  const dropped = Object.fromEntries(REASONS.map((reason) => [reason, { calls: 0, results: 0 }]));

  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      counts.set(call.id, (counts.get(call.id) || 0) + 1);
      const reason = invalidReason(call);
      if (!reason) continue;
      invalid.set(call, reason);
      reasons.set(call.id, reason);
      dropped[reason].calls += 1;
    }
  }
  if (!invalid.size) return messages;

  const result = [];
  for (const message of messages) {
    const reason = reasons.get(message.toolCallId);
    // A repeated source id cannot identify which call owns this result, so it
    // is kept rather than attributed to the wrong one.
    if (message.role === "tool" && reason && counts.get(message.toolCallId) === 1) {
      dropped[reason].results += 1;
      continue;
    }
    if (!message.toolCalls?.some((call) => invalid.has(call))) {
      result.push(message);
      continue;
    }
    const kept = { ...message, toolCalls: message.toolCalls.filter((call) => !invalid.has(call)) };
    if (!kept.toolCalls.length) {
      delete kept.toolCalls;
      // An assistant message that was only ever the call has nothing left.
      if (!kept.content?.trim()) continue;
    }
    result.push(kept);
  }

  const label = platform ? `${platform} ` : "";
  for (const reason of REASONS) {
    const counted = dropped[reason];
    if (counted.calls) {
      console.warn(`[everme] ${label}${reason} calls=${counted.calls} results=${counted.results}`);
    }
  }
  return result;
}

function invalidReason(call) {
  if (typeof call.name !== "string" || !call.name.trim()) return "invalid_tool_name";
  if (typeof call.arguments !== "string") return "invalid_tool_arguments";
  try {
    JSON.parse(call.arguments);
  } catch {
    return "invalid_tool_arguments";
  }
  return "";
}
