const SOFT_BYTES = 64 * 1024;
const HARD_BYTES = 280 * 1024;
const MAX_MESSAGES = 500;

const bytes = (message) => Buffer.byteLength(JSON.stringify(message));
const totalBytes = (messages) => messages.reduce((sum, message) => sum + bytes(message), 0);
const isText = (message) => ["user", "assistant"].includes(message.role)
  && typeof message.content === "string" && message.content !== "" && !message.toolCalls?.length;

export function batchUserTasks(messages, metadata = [], log = {}) {
  const tasks = userTasks(messages);
  const prepared = messages.map((message) => ({ ...message }));
  let trimmed = 0;
  for (const { start, end } of tasks) {
    const task = messages.slice(start, end);
    if (totalBytes(task) <= HARD_BYTES) continue;
    let candidate;
    for (const budget of [4096, 3072, 2048]) {
      candidate = task.map((message) => message.role === "tool" && typeof message.content === "string"
        ? { ...message, content: trimToolResult(message.content, budget) } : message);
      if (totalBytes(candidate) <= HARD_BYTES) break;
    }
    candidate.forEach((message, index) => {
      if (message.content !== task[index].content) trimmed++;
      prepared[start + index] = message;
    });
  }
  if (trimmed) log.info?.(`[everme] task-batching trimmedToolResults=${trimmed} minBytes=2048 maxBytes=4096`);
  return splitTasks(prepared, metadata, tasks);
}

function userTasks(messages) {
  const tasks = [];
  for (let start = 0; start < messages.length;) {
    let end = start + 1;
    while (end < messages.length && messages[end].role !== "user") end++;
    tasks.push({ start, end });
    start = end;
  }
  return tasks;
}

function trimToolResult(text, budget) {
  const raw = Buffer.from(text);
  if (raw.length <= budget) return text;
  const marker = (removed) => `\n[... trimmed ${removed} bytes of ${raw.length} ...]\n`;
  const available = budget - Buffer.byteLength(marker(raw.length));
  let head = Math.floor(available * 7 / 10);
  let tail = raw.length - (available - head);
  while (head > 0 && (raw[head] & 0xc0) === 0x80) head--;
  while (tail < raw.length && (raw[tail] & 0xc0) === 0x80) tail++;
  return raw.subarray(0, head).toString() + marker(tail - head) + raw.subarray(tail).toString();
}

function splitTasks(messages, metadata, tasks) {
  const sizes = messages.map(bytes);
  const protectedCuts = new Map();
  for (const task of tasks) {
    if (messages[task.start].role !== "user" || task.end - task.start > MAX_MESSAGES
      || sizes.slice(task.start, task.end).reduce((a, b) => a + b, 0) > HARD_BYTES) continue;
    for (let cut = task.start + 1; cut < task.end; cut++) protectedCuts.set(cut, task);
  }
  const { text, pairs } = boundaries(messages, metadata);
  const batches = [];
  for (let start = 0; start < messages.length;) {
    let hard = limitEnd(sizes, start, HARD_BYTES);
    if (start > 0 && messages[start].role !== "user") {
      for (let next = start + 1; next < hard; next++) {
        if (messages[next].role === "user") { hard = next; break; }
      }
    }
    const preferred = Math.min(limitEnd(sizes, start, SOFT_BYTES), hard);
    let end = preferred === messages.length ? preferred : chooseText(text, start, preferred, hard);
    if (!end) {
      for (let cut = hard; cut > start; cut--) {
        if (pairs.has(cut)) { end = cut; break; }
      }
    }
    if (!end) end = hard;
    const task = protectedCuts.get(end);
    if (task) end = task.end <= hard ? task.end : task.start;
    batches.push(messages.slice(start, end));
    start = end;
  }
  return batches;
}

function limitEnd(sizes, start, budget) {
  let end = start;
  let size = 0;
  while (end < sizes.length && end - start < MAX_MESSAGES) {
    if (end > start && size + sizes[end] > budget) break;
    size += sizes[end++];
  }
  return end;
}

function complete(messages, metadata, index) {
  if (messages[index].role !== "assistant" || messages[index].toolCalls?.length) return false;
  if (typeof metadata[index]?.turnComplete === "boolean") return metadata[index].turnComplete;
  return messages[index + 1]?.role === "user"
    || Boolean(metadata[index]?.turnId && metadata[index + 1]?.turnId
      && metadata[index].turnId !== metadata[index + 1].turnId);
}

function boundaries(messages, metadata) {
  const text = new Map();
  const pairs = new Set();
  const pending = new Map();
  messages.forEach((message, index) => {
    for (const call of message.toolCalls || []) pending.set(call.id, (pending.get(call.id) || 0) + 1);
    const count = pending.get(message.toolCallId);
    const matched = message.role === "tool" && count;
    if (matched) {
      if (count === 1) pending.delete(message.toolCallId);
      else pending.set(message.toolCallId, count - 1);
    }
    if (pending.size) return;
    const end = index + 1;
    if (matched && !(messages[end]?.role === "tool" && messages[end].toolCallId === message.toolCallId)) pairs.add(end);
    if (!isText(message) || (message.role === "assistant" && !complete(messages, metadata, index))) return;
    if (end === messages.length || messages[end].role === "user") text.set(end, 2);
    else if (message.role === "assistant" && isText(messages[end])) text.set(end, 1);
  });
  return { text, pairs };
}

function chooseText(boundaries, start, preferred, hard) {
  for (const kind of [2, 1]) {
    for (let end = preferred; end > start; end--) if (boundaries.get(end) === kind) return end;
    for (let end = preferred + 1; end <= hard; end++) if (boundaries.get(end) === kind) return end;
  }
  return 0;
}
