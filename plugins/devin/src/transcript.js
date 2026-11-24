import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function readLastTurn(transcriptPath, { log = console.error } = {}) {
  if (!transcriptPath) return [];
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let delta = [];
  const diagnostics = new Map();
  const dropped = reason => diagnostics.set(reason, (diagnostics.get(reason) || 0) + 1);

  for await (const line of lines) {
    if (!line.trim()) continue;
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      dropped("invalid_json");
      continue;
    }
    if (step?.status && step.status !== "done") continue;
    if (step?.type === "user_input") {
      const content = text(step?.user_input?.user_response);
      delta = content ? [{ role: "user", content }] : [];
      continue;
    }
    if (step?.type === "planner_response") {
      const content = text(step?.planner_response?.response);
      if (content) delta.push({ role: "assistant", content });
      continue;
    }
    dropped(step?.type === "code_action" ? "unsupported_tool_trace" : "unsupported_step_type");
  }

  for (const [reason, count] of diagnostics) log(`Devin transcript ${reason}: dropped_steps=${count}`);
  return delta;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
