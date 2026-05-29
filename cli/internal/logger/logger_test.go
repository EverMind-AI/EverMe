package logger

import (
	"bytes"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// readLog returns the buffer's contents and resets it. We Sync() first
// so any pending zap-internal writes have landed.
func readLog(t *testing.T, lg *Logger, buf *bytes.Buffer) string {
	t.Helper()
	lg.Sync()
	out := buf.String()
	buf.Reset()
	return out
}

func TestLogger_LevelGating(t *testing.T) {
	var buf bytes.Buffer
	lg := NewTo(&buf, LevelInfo)

	lg.Debugw("debug-shouldnt-show", "k", "v")
	lg.Infow("info-shows", "k", "v")

	out := readLog(t, lg, &buf)
	assert.NotContains(t, out, "debug-shouldnt-show", "Debug at level=Info must be suppressed")
	assert.Contains(t, out, "info-shows")
}

func TestLogger_TraceRequiresVV(t *testing.T) {
	var buf bytes.Buffer
	lg := NewTo(&buf, LevelDebug)
	lg.Tracew("trace-shouldnt-show")
	out := readLog(t, lg, &buf)
	assert.NotContains(t, out, "trace-shouldnt-show", "Trace at level=Debug must be suppressed (only LevelTrace emits)")

	lg = NewTo(&buf, LevelTrace)
	lg.Tracew("trace-shows")
	out = readLog(t, lg, &buf)
	assert.Contains(t, out, "trace-shows")
	assert.Contains(t, out, `"verbose":"trace"`, "Tracew must annotate output with verbose=trace so consumers can grep for it")
}

func TestLogger_RedactsEMK(t *testing.T) {
	var buf bytes.Buffer
	lg := NewTo(&buf, LevelInfo)

	// 32-hex form (canonical).
	lg.Infow("oops", "token", "emk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	// Permissive 20+ form.
	lg.Infow("oops2", "token", "evt_AbCdEfGhIjKlMnOpQrStUvWxYz0123")

	out := readLog(t, lg, &buf)
	assert.NotContains(t, out, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "32-hex emk body must be redacted")
	assert.NotContains(t, out, "AbCdEfGhIjKlMnOpQrStUvWxYz0123", "permissive emk/evt form must be redacted too")
	assert.Contains(t, out, "_REDACTED")
	// Prefix-only forms (apiKeyPrefix) must NOT be touched.
	lg.Infow("ok-prefix", "prefix", "emk_a7a9")
	out = readLog(t, lg, &buf)
	assert.Contains(t, out, "emk_a7a9", "intentionally-public prefixes must stay readable")
}

func TestLogger_PackageLevelSetIsRaceFree(t *testing.T) {
	var wg sync.WaitGroup
	wg.Add(20)
	var buf bytes.Buffer
	for i := 0; i < 10; i++ {
		go func() {
			defer wg.Done()
			Set(NewTo(&buf, LevelInfo))
		}()
	}
	for i := 0; i < 10; i++ {
		go func() {
			defer wg.Done()
			_ = L().Out()
		}()
	}
	wg.Wait()
}

func TestLogger_StructuredFieldsAreJSON(t *testing.T) {
	var buf bytes.Buffer
	lg := NewTo(&buf, LevelInfo)
	lg.Infow("hello", "n", 42, "platform", "claude-code")
	out := readLog(t, lg, &buf)

	// Cheap JSON sanity — full structural parsing would also need a
	// trailing newline / one-record-per-line guarantee, neither of
	// which we want to bake into the output contract here. Just check
	// the documented keys made it into the bytes.
	require.Contains(t, out, `"message":"hello"`)
	require.Contains(t, out, `"n":42`)
	require.Contains(t, out, `"platform":"claude-code"`)
	require.Contains(t, out, `"service":"evercli"`, "every record carries the service tag")
	// Encoder uses the LowercaseLevelEncoder; verify the level field
	// surfaces "info" rather than capitalized.
	assert.True(t, strings.Contains(out, `"level":"info"`))
}

func TestLogger_SetLevelMutates(t *testing.T) {
	var buf bytes.Buffer
	lg := NewTo(&buf, LevelInfo)
	lg.Debugw("hidden")
	out := readLog(t, lg, &buf)
	assert.NotContains(t, out, "hidden")

	lg.SetLevel(LevelDebug)
	lg.Debugw("now-shows")
	out = readLog(t, lg, &buf)
	assert.Contains(t, out, "now-shows", "SetLevel must take effect on subsequent calls")
}
