import { test } from "node:test";
import assert from "node:assert/strict";
import { humanTextFromWrappers } from "../index.js";

test("strips Conductor system_instruction blocks at the start and keeps what follows", () => {
  const linked = "\n<system_instruction>\nThe user has linked directories to this workspace.\n- /Users/u/app\n</system_instruction>\n\n修一下登录";
  const vm = "<system_instruction>\nThis workspace is running in a VM in the cloud.\n</system_instruction>\n" + linked;
  assert.equal(humanTextFromWrappers(linked), "修一下登录");
  assert.equal(humanTextFromWrappers(vm), "修一下登录");
  assert.equal(humanTextFromWrappers("<system_instruction>\nonly context\n</system_instruction>"), "");
});

test("strips OpenBot turn context blocks at the start", () => {
  const text = "<openbot_saved_memories>\nSaved memories\n<agent_memories count=\"1\">\n[{\"m\":\"likes tea\"}]\n</agent_memories>\n1 memory\n</openbot_saved_memories>\n<openbot_turn_style>\nbrief\n</openbot_turn_style>\n\nwhat is next?";
  assert.equal(humanTextFromWrappers(text), "what is next?");
});

test("unwraps a whole Cursor user_query envelope", () => {
  assert.equal(humanTextFromWrappers("<timestamp>Tuesday, Nov 18, 2026, 4:05 PM (UTC+8)</timestamp>\n<user_query>\n帮我看看\n</user_query>"), "帮我看看");
  assert.equal(humanTextFromWrappers("<user_query>\nhi\n</user_query>"), "hi");
});

test("drops a Herdr status note and keeps a Herdr relay as the person sent it", () => {
  assert.equal(humanTextFromWrappers("<hc>t2 reviewer is blocked (waiting for input). See: hc read t2</hc>"), "");
  const relay = "<hc from=\"t1 me\">please review</hc>";
  assert.equal(humanTextFromWrappers(relay), relay);
});

test("leaves the person's text alone when the wrappers are only quoted or unclosed", () => {
  for (const text of [
    "what does <system_instruction> do?",
    "<system_instruction> is unclosed here",
    "see <user_query>x</user_query> in the middle",
    "<openbot_saved_memories>\nunclosed",
    "<hc>t2 is fine</hc>",
  ]) assert.equal(humanTextFromWrappers(text), text);
});

test("an OpenBot block needs its own closing line, as in OpenBot's reader", () => {
  assert.equal(humanTextFromWrappers("<openbot_steer>\n</openbot_steer>\nhi"), "<openbot_steer>\n</openbot_steer>\nhi");
});
