/**
 * Build the messages a Devin hook event contributes to a conversation.
 *
 * Devin hands each hook a `tool_info` shaped for that event rather than a
 * transcript file: post_cascade_response carries the answer inline,
 * post_run_command carries the command that ran. A real session emitted
 * post_cascade_response and never post_cascade_response_with_transcript,
 * so there is no transcript to parse — the turn is assembled here.
 */

export function messagesForEvent(event, input = {}, pendingPrompt = "") {
  const toolInfo = input?.toolInfo ?? {};
  switch (event) {
    case "post_cascade_response":
      return responseMessages(toolInfo, pendingPrompt);
    // turnId is the event's execution_id (see adapter.normalizeInput).
    case "post_run_command":
      return toolCallMessages("run_command", pick(toolInfo, ["command_line", "cwd"]), "command_line", input?.turnId);
    case "post_read_code":
      return toolCallMessages("read_code", pick(toolInfo, ["file_path"]), "file_path", input?.turnId);
    default:
      return [];
  }
}

function pick(toolInfo, keys) {
  const out = {};
  for (const key of keys) {
    const value = text(toolInfo[key]);
    if (value) out[key] = value;
  }
  return out;
}

function responseMessages(toolInfo, pendingPrompt) {
  const response = text(toolInfo.response);
  if (!response) return [];
  const prompt = text(pendingPrompt);
  const messages = [];
  // The prompt arrives on a different event (and a different process), so
  // it is only here when pre_user_prompt stashed it. Storing the answer
  // alone is still better than storing nothing.
  if (prompt) messages.push({ role: "user", content: prompt });
  messages.push({ role: "assistant", content: response });
  return messages;
}

// No paired tool result is emitted: Devin reports what a tool was asked
// to do but not what came back, and a fabricated empty result would claim
// we captured output we never saw.
function toolCallMessages(name, args, requiredKey, executionId) {
  if (!args[requiredKey]) return [];
  return [{
    role: "assistant",
    toolCalls: [{
      id: `devin_${executionId || args[requiredKey]}`,
      type: "function",
      name,
      arguments: JSON.stringify(args),
    }],
  }];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
