import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function readLastTurn(transcriptPath) {
  if (!transcriptPath) return [];
  const lines = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let delta = [];
  let foundUser = false;

  for await (const line of lines) {
    let step;
    try {
      step = JSON.parse(line);
    } catch {
      continue;
    }
    if (step?.status && step.status !== "done") continue;
    if (step?.type === "user_input") {
      const content = text(step?.user_input?.user_response);
      if (!content) continue;
      delta = [{ role: "user", content }];
      foundUser = true;
      continue;
    }
    if (foundUser && step?.type === "planner_response") {
      const content = text(step?.planner_response?.response);
      if (content) delta.push({ role: "assistant", content });
    }
  }

  return foundUser ? delta : [];
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
