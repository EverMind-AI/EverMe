// Package logger is the evercli structured logger: sugared keys-and-values,
// level-driven verbosity, and an AtomicLevel so the level can be raised at
// runtime if needed.
//
// All log lines are routed through a redacting encoder so that an
// accidentally-logged emk_ / evt_ token is masked before reaching disk
// or stderr. Defense in depth: callers shouldn't put secrets into log
// messages in the first place, but the encoder is the safety net.
package logger

import (
	"io"
	"os"
	"sync"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/buffer"
	"go.uber.org/zap/zapcore"

	"evercli/internal/output"
)

// Level mirrors the --verbose count: 0 = info (default), 1 = debug, 2+ = trace.
// Trace maps to DebugLevel internally with an additional `verbose=trace`
// field so consumers can grep for either.
type Level int

const (
	LevelInfo  Level = iota // -v not passed
	LevelDebug              // -v
	LevelTrace              // -vv (or more)
)

// Logger is the evercli logger handle.
type Logger struct {
	z      *zap.Logger
	level  Level
	atomic zap.AtomicLevel
	out    io.Writer
}

var (
	pkgMu     sync.RWMutex
	pkgLogger = New(LevelInfo)
)

// New builds a stderr-only logger at the given level. Production
// callers reach the logger via L() / Set(); New is invoked exactly
// once at bootstrap from cmdctx.BuildDeps.
func New(l Level) *Logger { return newAt(os.Stderr, l) }

// NewTo lets tests redirect log output. The provided writer is wrapped
// in a thread-safe writer so concurrent log lines don't interleave.
func NewTo(w io.Writer, l Level) *Logger { return newAt(w, l) }

func newAt(w io.Writer, l Level) *Logger {
	atom := zap.NewAtomicLevelAt(zapLevel(l))

	enc := zapcore.NewJSONEncoder(zapcore.EncoderConfig{
		MessageKey:    "message",
		LevelKey:      "level",
		TimeKey:       "timestamp",
		NameKey:       "logger",
		CallerKey:     zapcore.OmitKey,
		StacktraceKey: zapcore.OmitKey,
		EncodeLevel:   zapcore.LowercaseLevelEncoder,
		EncodeTime: func(t time.Time, e zapcore.PrimitiveArrayEncoder) {
			e.AppendString(t.UTC().Format("2006-01-02 15:04:05.000"))
		},
		EncodeDuration: zapcore.MillisDurationEncoder,
	})
	core := zapcore.NewCore(redactingEncoder{Encoder: enc}, zapcore.AddSync(w), atom)
	z := zap.New(core).With(zap.String("service", "evercli"))

	return &Logger{
		z:      z,
		level:  l,
		atomic: atom,
		out:    w,
	}
}

func zapLevel(l Level) zapcore.Level {
	switch l {
	case LevelDebug, LevelTrace:
		return zapcore.DebugLevel
	default:
		return zapcore.InfoLevel
	}
}

// Set replaces the package-default logger. Idempotent; safe to call from
// any goroutine. cmdctx.BuildDeps calls this once per RunE.
func Set(l *Logger) {
	if l == nil {
		return
	}
	pkgMu.Lock()
	defer pkgMu.Unlock()
	pkgLogger = l
}

// L returns the package-default logger. Cheap; safe for hot paths.
func L() *Logger {
	pkgMu.RLock()
	defer pkgMu.RUnlock()
	return pkgLogger
}

// SetLevel adjusts the logger's level at runtime. Useful when a long-
// running flow (Device Flow polling) wants to raise verbosity without
// restarting the binary.
func (l *Logger) SetLevel(lv Level) {
	l.level = lv
	l.atomic.SetLevel(zapLevel(lv))
}

// Sync flushes any buffered log lines. Best-effort — Zap returns errors
// for transient platform quirks (stdout sync on macOS) that we don't
// want to bubble up.
func (l *Logger) Sync() { _ = l.z.Sync() }

// ---- Sugared structured logging ----------------------------------------
//
// The *w (keys-and-values) variants follow zap's sugared idiom and the
// server's pkg/log surface. Prefer these for new code; the *f variants
// are kept for callers migrating from the previous Printf-style logger.

func (l *Logger) Debugw(msg string, kv ...interface{}) {
	if l.level < LevelDebug {
		return
	}
	l.z.Sugar().Debugw(msg, kv...)
}

func (l *Logger) Infow(msg string, kv ...interface{}) { l.z.Sugar().Infow(msg, kv...) }

func (l *Logger) Warnw(msg string, kv ...interface{}) { l.z.Sugar().Warnw(msg, kv...) }

func (l *Logger) Errorw(msg string, kv ...interface{}) { l.z.Sugar().Errorw(msg, kv...) }

// Tracew is debug-level with an extra `verbose=trace` field so callers
// can grep finer-grained spans without losing structured correlation.
func (l *Logger) Tracew(msg string, kv ...interface{}) {
	if l.level < LevelTrace {
		return
	}
	kv = append(kv, "verbose", "trace")
	l.z.Sugar().Debugw(msg, kv...)
}

// ---- Printf-style (legacy callers) -------------------------------------

func (l *Logger) Infof(format string, args ...interface{})  { l.z.Sugar().Infof(format, args...) }
func (l *Logger) Warnf(format string, args ...interface{})  { l.z.Sugar().Warnf(format, args...) }
func (l *Logger) Errorf(format string, args ...interface{}) { l.z.Sugar().Errorf(format, args...) }
func (l *Logger) Debugf(format string, args ...interface{}) {
	if l.level < LevelDebug {
		return
	}
	l.z.Sugar().Debugf(format, args...)
}
func (l *Logger) Tracef(format string, args ...interface{}) {
	if l.level < LevelTrace {
		return
	}
	l.z.Sugar().Debugf(format, args...)
}

// Out returns the logger's underlying writer. Test-only — production
// callers go through the structured methods above.
func (l *Logger) Out() io.Writer { return l.out }

// ---- redacting encoder -------------------------------------------------
//
// redactingEncoder wraps a zapcore.Encoder, replacing emk_/evt_ tokens
// in the marshalled bytes before they hit disk. Zap clones encoders for
// thread-safety, so we mirror Clone() to keep that contract. We rely on
// internal/output.RedactBytes (which is exported below as a package-
// public alias) so the same regex powers envelope masking and log
// masking — no chance of one masking layer drifting from the other.
type redactingEncoder struct {
	zapcore.Encoder
}

func (r redactingEncoder) Clone() zapcore.Encoder {
	return redactingEncoder{Encoder: r.Encoder.Clone()}
}

func (r redactingEncoder) EncodeEntry(ent zapcore.Entry, fields []zapcore.Field) (*buffer.Buffer, error) {
	buf, err := r.Encoder.EncodeEntry(ent, fields)
	if err != nil {
		return buf, err
	}
	original := buf.Bytes()
	masked := output.RedactLogBytes(original)
	if len(masked) == len(original) {
		// Cheap: lengths only differ when a token actually matched
		// (mask preserves an 8-byte prefix and writes "_REDACTED"
		// suffix, never the same length as the original 36 bytes).
		return buf, nil
	}
	// Replace contents in place so callers (zap's internal pool) get a
	// buffer of the expected shape.
	buf.Reset()
	_, _ = buf.Write(masked)
	return buf, nil
}
