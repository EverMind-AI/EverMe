package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fullEMK / fullEVT are realistic-shape credentials embedded in tests
// to verify the output layer scrubs them. The regexp the redactor uses
// (32 lowercase hex after `emk_` / `evt_`) is the same shape backend
// emits, so a test failure here would imply a real-world leak.
const (
	fullEMK = "emk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fullEVT = "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// fullCredRe is the same shape callers should never have to think
// about. We use it post-render to confirm zero matches.
var fullCredRe = regexp.MustCompile(`(emk|evt)_[a-f0-9]{32}`)

func TestRedact_ReplacesFullEMK(t *testing.T) {
	out := redact([]byte("token leaked: " + fullEMK + " end"))
	assert.NotContains(t, string(out), fullEMK)
	assert.Contains(t, string(out), "emk_aaaa_REDACTED")
}

func TestRedact_ReplacesFullEVT(t *testing.T) {
	out := redact([]byte("config has " + fullEVT))
	assert.NotContains(t, string(out), fullEVT)
	assert.Contains(t, string(out), "evt_bbbb_REDACTED")
}

func TestRedact_LeavesPrefixesAlone(t *testing.T) {
	// 8-char prefix is intentional public surface (auth status returns
	// apiKeyPrefix). Must not be touched.
	in := []byte(`{"apiKeyPrefix":"emk_a7a9","tokenPrefix":"evt_b9c3"}`)
	out := redact(in)
	assert.Equal(t, in, out)
}

func TestWriter_Err_RedactsEMKInMessage(t *testing.T) {
	// Simulate the worst case: a caller built a CLIError whose Message
	// inadvertently embeds a full emk (e.g. wrapped error text from a
	// noisy lower layer).
	var stdout, stderr bytes.Buffer
	w := NewWriterTo(&stdout, &stderr, FormatJSON)

	cause := fmt.Errorf("read failed for %s", fullEMK)
	cli := IOErr("/path", "read", cause)

	exit := w.Err(cli)
	require.NotNil(t, exit)

	assert.NotContains(t, stdout.String(), fullEMK,
		"stdout envelope must not contain full emk")
	assert.NotRegexp(t, fullCredRe, stdout.String(),
		"stdout must not contain any full-form credential")
}

func TestWriter_Err_TextStderr_AlsoRedacts(t *testing.T) {
	var stdout, stderr bytes.Buffer
	w := NewWriterTo(&stdout, &stderr, FormatText)

	cause := errors.New("found " + fullEVT + " in config")
	cli := IOErr("/path", "parse", cause)

	_ = w.Err(cli)
	assert.NotContains(t, stderr.String(), fullEVT,
		"stderr text path must redact too")
	assert.NotRegexp(t, fullCredRe, stderr.String())
}

func TestWriter_OK_RedactsCredentialInData(t *testing.T) {
	// If a command author put a full credential in OK data (programming
	// bug), output must still scrub it.
	var stdout, stderr bytes.Buffer
	w := NewWriterTo(&stdout, &stderr, FormatJSON)

	type leakyData struct {
		Token string `json:"token"`
	}
	require.NoError(t, w.OK(leakyData{Token: fullEMK}, nil))

	assert.NotContains(t, stdout.String(), fullEMK)
	assert.NotRegexp(t, fullCredRe, stdout.String())

	// Sanity: the envelope is still well-formed JSON after redaction.
	var env Envelope
	require.NoError(t, json.Unmarshal(stdout.Bytes(), &env))
	assert.True(t, env.Ok)
}

func TestRedact_AcceptsPermissiveCredentialShapes(t *testing.T) {
	// Backend may at some point switch from 32-hex to a longer / mixed-
	// case form. The new permissive regex (>=20 alphanumerics, dash,
	// underscore) must still match.
	mixed := "emk_AbCdEfGhIjKlMnOpQrStUvWx0123456789"
	out := redact([]byte("got: " + mixed + " end"))
	assert.NotContains(t, string(out), mixed, "permissive emk shape must be redacted")
	assert.Contains(t, string(out), "_REDACTED")
}

func TestRedactLogBytes_AliasesRedact(t *testing.T) {
	in := []byte("emit emk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	a := redact(in)
	b := RedactLogBytes(in)
	assert.Equal(t, a, b, "RedactLogBytes is the public alias used by the logger encoder; behavior must match")
}

func TestWriter_OK_RedactsInDetail(t *testing.T) {
	// Detail values get marshaled verbatim; verify map entries are
	// covered by the byte-level redactor.
	var stdout, stderr bytes.Buffer
	w := NewWriterTo(&stdout, &stderr, FormatJSON)

	cli := &CLIError{
		Type:    TypeAuth,
		Message: "revoked",
		Detail:  map[string]interface{}{"leaked": fullEMK},
	}
	_ = w.Err(cli)

	assert.NotContains(t, stdout.String(), fullEMK)
	assert.NotRegexp(t, fullCredRe, stdout.String())
}

func TestFatalErr_RedactsCredentialInEnvelope(t *testing.T) {
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	require.NoError(t, err)
	os.Stdout = w
	t.Cleanup(func() {
		os.Stdout = oldStdout
		_ = r.Close()
	})

	got := FatalErr(errors.New("bootstrap saw " + fullEVT))
	require.NoError(t, w.Close())
	out, err := io.ReadAll(r)
	require.NoError(t, err)

	var ee *ExitError
	require.ErrorAs(t, got, &ee)
	assert.NotContains(t, string(out), fullEVT)
	assert.NotRegexp(t, fullCredRe, string(out))
	assert.Contains(t, string(out), "evt_bbbb_REDACTED")
}
