/**
 * Build the messages a Devin hook event contributes to a conversation.
 *
 * Devin Local's Stop carries the final answer; the prompt comes from the
 * UserPromptSubmit stash of the same prompt_id.
 * Cascade inline responses are turn summaries, not necessarily final answers.
 * Command and read hooks lack native call identities and cannot form tool pairs.
 */

export function messagesForEvent(event, input = {}, pendingPrompt = null, { log = console.error } = {}) {
  const toolInfo = input?.toolInfo ?? {};
  const prompt = text(pendingPrompt?.prompt);
  const messages = prompt ? [{ role: "user", content: prompt, ...timestampField(pendingPrompt.timestamp) }] : [];
  switch (event) {
    case "Stop":
      return [...messages, ...assistantMessage(input.lastAssistantMessage, input.timestamp)];
    case "post_cascade_response":
      return [...messages, ...responseMessages(toolInfo, input.timestamp)];
    case "post_run_command":
    case "post_read_code":
      // execution_id identifies the turn, not a call. These hooks supply no
      // native call ID or result, so neither can be reconstructed reliably.
      log("Devin tool event skipped: missing native tool call ID");
      return messages;
    default:
      return [];
  }
}

function responseMessages(toolInfo, timestamp) {
  return assistantMessage(toolInfo.response, timestamp);
}

function assistantMessage(value, timestamp) {
  const response = text(value);
  if (!response) return [];
  return [{ role: "assistant", content: response, ...timestampField(timestamp) }];
}

function timestampField(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? { timestamp } : {};
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
