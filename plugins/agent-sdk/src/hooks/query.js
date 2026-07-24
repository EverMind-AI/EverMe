const INJECTED_BLOCK_RE = /<everme_(?:recall|profile)>[\s\S]*?<\/everme_(?:recall|profile)>/gi;
const LEADING_COMMAND_RE = /^\s*\/[^\s]+(?:\s+|$)/u;

export function sanitizeRecallQuery(text) {
  return String(text ?? "")
    .replace(INJECTED_BLOCK_RE, " ")
    .replace(LEADING_COMMAND_RE, "")
    .replace(/\s+/gu, " ")
    .trim();
}
