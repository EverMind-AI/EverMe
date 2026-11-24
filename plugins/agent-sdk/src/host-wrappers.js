// Wrappers that orchestrators and IDEs put around what the person typed when
// they drive a coding agent. Each rule mirrors the writer's own shape, or the
// writer's own reader where it has one; anything that does not match exactly
// is left as the person sent it. Host parsers call this on a user message that
// already passed their own rules; the shared write path never does.

// Conductor reads a user message back by dropping every leading
// <system_instruction> block (workspace notes, linked directories).
const CONDUCTOR_BLOCK = /^<system_instruction>[\s\S]*?<\/system_instruction>/;
// OpenBot's withoutTurnContext: the turn-context blocks it prepends.
const OPENBOT_BLOCK = /^<(openbot_saved_memories|openbot_saved_memories_update|openbot_section_teammates|openbot_agent_instructions|openbot_saved_logins|openbot_turn_style|openbot_steer|openbot_background_wake)>\n[\s\S]*?\n<\/\1>/;
// Cursor wraps the prompt in <user_query>, optionally after a <timestamp>.
const CURSOR_ENVELOPE = /^(?:<timestamp>[^<\n]*<\/timestamp>\n)?<user_query>\n?([\s\S]*?)\n?<\/user_query>$/;
// Herdr Core's note() about a child terminal; nobody types it.
const HERDR_STATUS = /^<hc>\S+(?: [^\n]*)? (?:is blocked \(|hit an error|exited \()[\s\S]*(?:See|Read): hc read \S+<\/hc>$/;

export function humanTextFromWrappers(text) {
  let rest = String(text ?? "").trim();
  for (;;) {
    const block = rest.match(CONDUCTOR_BLOCK) ?? rest.match(OPENBOT_BLOCK);
    if (!block) break;
    rest = rest.slice(block[0].length).trim();
  }
  const cursor = rest.match(CURSOR_ENVELOPE);
  if (cursor) rest = cursor[1].trim();
  if (HERDR_STATUS.test(rest)) return "";
  return rest === String(text ?? "").trim() ? text : rest;
}
