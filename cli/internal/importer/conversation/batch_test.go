package conversation

import (
	"strings"
	"testing"
)

func TestBatchMessagesByBytesEmpty(t *testing.T) {
	if got := batchMessagesByBytes(nil, 1000); len(got) != 0 {
		t.Fatalf("empty input must yield no batches, got %d", len(got))
	}
}

func TestBatchMessagesByBytesSingleBatchWhenUnderBudget(t *testing.T) {
	msgs := []AgentMemoryMessage{
		{Role: "user", Timestamp: 1, Content: "hi"},
		{Role: "assistant", Timestamp: 2, Content: "hello"},
	}
	got := batchMessagesByBytes(msgs, 64*1024)
	if len(got) != 1 || len(got[0]) != 2 {
		t.Fatalf("small set must be one batch of 2, got %d batches", len(got))
	}
}

func TestBatchMessagesByBytesSplitsOnBudgetPreservingOrderAndCompleteness(t *testing.T) {
	mk := func(role string, n int) AgentMemoryMessage {
		return AgentMemoryMessage{Role: role, Timestamp: int64(n), Content: strings.Repeat("x", 4000)}
	}
	msgs := []AgentMemoryMessage{mk("a", 1), mk("b", 2), mk("c", 3), mk("d", 4), mk("e", 5)}
	budget := 9000 // ~2 of the ~4KB messages per batch

	got := batchMessagesByBytes(msgs, budget)
	if len(got) < 2 {
		t.Fatalf("oversized set must split into >1 batch, got %d", len(got))
	}

	// Completeness + order: flattening must equal the input exactly.
	var flat []AgentMemoryMessage
	for _, b := range got {
		if len(b) == 0 {
			t.Fatalf("no empty batches allowed")
		}
		flat = append(flat, b...)
	}
	if len(flat) != len(msgs) {
		t.Fatalf("lost/duplicated messages: %d vs %d", len(flat), len(msgs))
	}
	for i := range flat {
		if flat[i].Timestamp != msgs[i].Timestamp {
			t.Fatalf("order not preserved at %d", i)
		}
	}

	// Each multi-message batch must stay within budget.
	for i, b := range got {
		if len(b) > 1 {
			sum := 0
			for _, m := range b {
				sum += messageBytes(m)
			}
			if sum > budget {
				t.Fatalf("batch %d exceeds budget: %d > %d", i, sum, budget)
			}
		}
	}
}

func TestBatchMessagesByBytesOversizedSingleMessageGoesAlone(t *testing.T) {
	huge := AgentMemoryMessage{Role: "tool", Timestamp: 1, ToolCallID: "c", Content: strings.Repeat("x", 50000)}
	small := AgentMemoryMessage{Role: "user", Timestamp: 2, Content: "ok"}
	got := batchMessagesByBytes([]AgentMemoryMessage{huge, small}, 9000)
	if len(got) != 2 {
		t.Fatalf("oversized message must occupy its own batch: got %d batches", len(got))
	}
	if len(got[0]) != 1 || got[0][0].ToolCallID != "c" {
		t.Fatalf("first batch must hold the oversized message alone")
	}
}
