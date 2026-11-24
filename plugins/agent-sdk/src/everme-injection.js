// EverMe's own memory MCP server must never be quoted back to EverMe. The
// server extracts whatever it receives, so uploading a recall turns
// already-extracted episodes into new ones filed under whichever agent
// performed the recall.
//
// This lives on the shared write path rather than in each host's transcript
// parser, so a plugin inherits it by sending at all. Matching is by
// provenance - which MCP server the call went to - never by content, because
// real tool output that happens to quote a memory fence is conversation.

const EVERME_MEMORY_TOOLS = new Set(["mem_context", "mem_search", "mem_skill", "mem_save_turn", "mem_save_fact"]);
const MCP_RESOURCE_TOOLS = new Set(["read_mcp_resource", "list_mcp_resources"]);

// Matches an MCP server identifier however the host spells it: a bare
// "everme", the "mcp__" prefix Codex adds, or the compound "connector__everme"
// MiniMax records. Per token, so a server merely containing the letters does
// not qualify.
function isEvermeMcpServer(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return text.split(/[_\-./:]+/).some((token) => token === "everme" || token === "everos");
}

// "connector__everme__mem_context" -> ["connector__everme", "mem_context"].
// A name with no prefix yields an empty server, meaning "not recorded".
function splitMcpToolName(value) {
  const name = String(value || "").trim().toLowerCase();
  const sep = name.lastIndexOf("__");
  return sep >= 0 ? [name.slice(0, sep), name.slice(sep + 2)] : ["", name];
}

function decodeArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Whichever field names the MCP server is decisive, in both directions: a call
// that explicitly belongs to someone else's server keeps its content even when
// that server exposes a tool by the same name. Only when no server is recorded
// anywhere does the bare tool name decide.
export function isEvermeMemoryTool(call) {
  if (!call) return false;
  const namespace = String(call.namespace || "").trim();
  if (namespace) return isEvermeMcpServer(namespace);
  const [server, base] = splitMcpToolName(call.name);
  if (server) return isEvermeMcpServer(server);
  if (!base) return false;
  if (EVERME_MEMORY_TOOLS.has(base)) return true;
  if (!MCP_RESOURCE_TOOLS.has(base)) return false;
  const args = decodeArguments(call.arguments ?? call.input);
  return isEvermeMcpServer(args.server) ||
    String(args.uri || "").trim().startsWith("mem://");
}

// Removes EverMe memory calls and the results paired with them by call id, so
// no tool result is left orphaned. A message that carried text alongside the
// call keeps its text.
export function dropEvermeMemoryToolPairs(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const dropped = new Set();
  for (const message of messages) {
    for (const call of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
      if (isEvermeMemoryTool(call)) dropped.add(call.id);
    }
    // A result can arrive in a batch of its own when the call was already
    // uploaded and checkpointed; then its own provenance is all there is.
    if ((message?.toolCallId || message?.tool_call_id) &&
        isEvermeMemoryTool({ name: message?.toolName, namespace: message?.namespace })) {
      dropped.add(message.toolCallId || message.tool_call_id);
    }
  }
  if (!dropped.size) return messages;

  const kept = [];
  for (const message of messages) {
    const resultId = message?.toolCallId || message?.tool_call_id;
    if (resultId && dropped.has(resultId)) continue;
    if (Array.isArray(message?.toolCalls) && message.toolCalls.length) {
      const remaining = message.toolCalls.filter((call) => !dropped.has(call.id));
      if (!remaining.length && !hasContent(message)) continue;
      kept.push(remaining.length === message.toolCalls.length ? message : { ...message, toolCalls: remaining });
      continue;
    }
    kept.push(message);
  }
  return kept;
}

function hasContent(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim() !== "";
  return Array.isArray(content) ? content.length > 0 : content != null;
}
