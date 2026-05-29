package output

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"gopkg.in/yaml.v3"
)

// Writer is the single funnel through which every command emits its
// final result. Construct one per command via NewWriter, then call OK,
// Err, or FatalErr exactly once before the RunE returns.
//
// Writer keeps stdout and stderr as separate sinks (stdout for the
// envelope and human-format business output, stderr for everything else).
// Writer never writes log lines; that is internal/logger's job.
type Writer struct {
	out        io.Writer
	err        io.Writer
	format     Format
	textRender TextRenderer
}

// TextRenderer formats a successful Data payload for human consumption.
// Set per-command via WithTextRenderer; if absent, the writer falls back
// to a generic "<status> message + value dump" format.
type TextRenderer func(w io.Writer, data interface{}) error

// NewWriter constructs a Writer bound to stdout/stderr with the requested
// format. Use NewWriterTo when injecting custom sinks (tests).
func NewWriter(format Format) *Writer {
	resolved := ResolveFormat(format, os.Stdout)
	return &Writer{out: os.Stdout, err: os.Stderr, format: resolved}
}

// NewWriterTo wires a Writer to caller-supplied sinks; mainly for tests
// that want bytes.Buffer / strings.Builder. Auto-resolution still applies
// — if you pass FormatAuto with a non-tty out (the typical buffer case),
// you'll get FormatJSON.
func NewWriterTo(out, err io.Writer, format Format) *Writer {
	resolved := ResolveFormat(format, out)
	return &Writer{out: out, err: err, format: resolved}
}

// Format returns the resolved (concrete) format. Useful for command code
// that wants to branch on text vs structured before rendering.
func (w *Writer) Format() Format { return w.format }

// Stderr exposes the stderr sink for callers (loggers, progress bars).
// Commands should never write directly to os.Stderr; route through here
// so tests can capture.
func (w *Writer) Stderr() io.Writer { return w.err }

// Stdout exposes the stdout sink. Use sparingly — most success paths
// should go through OK, which manages the envelope wrapping for you.
func (w *Writer) Stdout() io.Writer { return w.out }

// (SetNotice / Notice were retired with `evercli update` and the
// plugin-uninstall partial-success warning channel; see envelope.go.)

// WithTextRenderer customizes the human format for one Writer instance.
// Returns the writer for chaining.
func (w *Writer) WithTextRenderer(r TextRenderer) *Writer {
	w.textRender = r
	return w
}

// OK emits a successful envelope and returns nil — i.e. the cobra RunE
// should exit 0. Pass a nil Meta when there's no count / requestId to
// report.
//
// Output bytes pass through redact() before reaching w.out so a
// full-form emk_/evt_ accidentally embedded by a caller is masked
// before the envelope leaves the process (defense-in-depth).
func (w *Writer) OK(data interface{}, meta *Meta) error {
	switch w.format {
	case FormatText:
		if w.textRender != nil {
			if err := w.textRender(w.out, data); err != nil {
				return err
			}
		} else {
			fmt.Fprintln(w.out, "ok")
		}
		return nil
	case FormatYAML:
		raw, err := yaml.Marshal(Envelope{Ok: true, Data: data, Meta: meta})
		if err != nil {
			return err
		}
		_, err = w.out.Write(redact(raw))
		return err
	default: // FormatJSON
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetIndent("", "  ")
		if err := enc.Encode(Envelope{Ok: true, Data: data, Meta: meta}); err != nil {
			return err
		}
		_, err := w.out.Write(redact(buf.Bytes()))
		return err
	}
}

// Err classifies err, writes the failure envelope to stdout (json/yaml)
// or a one-line message to stderr (text), and returns an *ExitError so
// main.go exits with the matching code.
//
// Calling Err with a nil error is a programming bug; we panic in that
// case rather than silently emit a bogus envelope.
func (w *Writer) Err(err error) error {
	if err == nil {
		panic("output.Writer.Err called with nil error")
	}
	ce := ClassifyError(err)
	exit := ce.Type.ExitCode()

	body := ErrorBody{
		Type:    ce.Type,
		Code:    ce.Code,
		Message: ce.Message,
		Hint:    ce.Hint,
		Detail:  ce.Detail,
	}
	var meta *Meta
	if rid, ok := ce.Detail["requestId"].(string); ok && rid != "" {
		meta = &Meta{RequestID: rid}
	}

	switch w.format {
	case FormatText:
		// Human format: short line on stderr; stdout stays empty so that
		// callers piping `evercli ... > result.json` don't get a half-baked
		// file on failure. Stderr text also goes through redact() so an
		// accidentally-included emk doesn't leak via this channel.
		fmt.Fprintf(w.err, "%s", redact([]byte(fmt.Sprintf("error: %s\n", ce.Message))))
		if ce.Hint != "" {
			fmt.Fprintf(w.err, "%s", redact([]byte(fmt.Sprintf("hint: %s\n", ce.Hint))))
		}
	case FormatYAML:
		raw, err := yaml.Marshal(ErrorEnvelope{Ok: false, Error: body, Meta: meta})
		if err != nil {
			fmt.Fprintf(w.err, "error: %s (also: failed to marshal envelope: %v)\n", ce.Message, err)
		} else if _, err := w.out.Write(redact(raw)); err != nil {
			fmt.Fprintf(w.err, "error: %s (also: failed to write envelope: %v)\n", ce.Message, err)
		}
	default:
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetIndent("", "  ")
		if err := enc.Encode(ErrorEnvelope{Ok: false, Error: body, Meta: meta}); err != nil {
			fmt.Fprintf(w.err, "error: %s (also: failed to encode envelope: %v)\n", ce.Message, err)
		} else if _, err := w.out.Write(redact(buf.Bytes())); err != nil {
			fmt.Fprintf(w.err, "error: %s (also: failed to write envelope: %v)\n", ce.Message, err)
		}
	}

	return &ExitError{Code: exit}
}

// FatalErr is for catastrophic bootstrap failures where we couldn't even
// build a Writer (config load broke, etc.). It writes a minimal JSON
// envelope to stdout and returns ExitInternal. Caller is expected to
// propagate the returned error from RunE.
func FatalErr(err error) error {
	ce := ClassifyError(err)
	body := ErrorBody{
		Type:    ce.Type,
		Code:    ce.Code,
		Message: ce.Message,
		Hint:    ce.Hint,
		Detail:  ce.Detail,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if encErr := enc.Encode(ErrorEnvelope{Ok: false, Error: body}); encErr != nil {
		fmt.Fprintf(os.Stderr, "fatal: %s (also: %v)\n", ce.Message, encErr)
	} else if _, writeErr := os.Stdout.Write(redact(buf.Bytes())); writeErr != nil {
		fmt.Fprintf(os.Stderr, "fatal: %s (also: failed to write envelope: %v)\n", ce.Message, writeErr)
	}
	return &ExitError{Code: ce.Type.ExitCode()}
}
