package conversation

import "encoding/json"

// maxAgentBatchBytes bounds the size of a single agent-memory POST. A whole
// session is split into batches under this budget and uploaded as multiple
// add calls under the same conversationId. EverOS rejects oversized agent
// payloads (its boundary detector is tuned for ~32K-token batches), so an
// unbounded single POST of a large session fails upstream. 64 KiB maps to
// well under that token budget and stays below empirically-passing sizes.
const maxAgentBatchBytes = 64 * 1024

// messageBytes is the marshaled JSON size of one message — the unit the batch
// budget accounts in.
func messageBytes(m AgentMemoryMessage) int {
	b, err := json.Marshal(m)
	if err != nil {
		return 0
	}
	return len(b)
}

// batchMessagesByBytes splits msgs into ordered batches whose per-message byte
// sizes sum to at most budget. Order is preserved and every message appears
// exactly once. A single message larger than budget occupies its own batch
// (never dropped, never split). budget <= 0 means no limit (one batch).
func batchMessagesByBytes(msgs []AgentMemoryMessage, budget int) [][]AgentMemoryMessage {
	if len(msgs) == 0 {
		return nil
	}
	if budget <= 0 {
		return [][]AgentMemoryMessage{msgs}
	}
	var batches [][]AgentMemoryMessage
	var cur []AgentMemoryMessage
	curBytes := 0
	for _, m := range msgs {
		mb := messageBytes(m)
		if len(cur) > 0 && curBytes+mb > budget {
			batches = append(batches, cur)
			cur = nil
			curBytes = 0
		}
		cur = append(cur, m)
		curBytes += mb
	}
	if len(cur) > 0 {
		batches = append(batches, cur)
	}
	return batches
}
