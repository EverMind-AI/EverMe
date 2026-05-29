package output

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestWriter(format Format) (*Writer, *bytes.Buffer, *bytes.Buffer) {
	var out, errBuf bytes.Buffer
	w := NewWriterTo(&out, &errBuf, format)
	return w, &out, &errBuf
}

func TestWriter_OK_JSON(t *testing.T) {
	w, out, errBuf := newTestWriter(FormatJSON)
	err := w.OK(map[string]string{"hello": "world"}, &Meta{Count: 1, RequestID: "req-1"})
	require.NoError(t, err)

	var env Envelope
	require.NoError(t, json.Unmarshal(out.Bytes(), &env))

	assert.True(t, env.Ok)
	assert.Equal(t, "world", env.Data.(map[string]interface{})["hello"])
	require.NotNil(t, env.Meta)
	assert.Equal(t, 1, env.Meta.Count)
	assert.Equal(t, "req-1", env.Meta.RequestID)
	assert.Empty(t, errBuf.String(), "stderr should stay empty on success")
}

func TestWriter_OK_TextFallback(t *testing.T) {
	w, out, _ := newTestWriter(FormatText)
	err := w.OK("anything", nil)
	require.NoError(t, err)
	assert.Equal(t, "ok\n", out.String())
}

func TestWriter_OK_TextRendererCustom(t *testing.T) {
	w, out, _ := newTestWriter(FormatText)
	w.WithTextRenderer(func(o io.Writer, data interface{}) error {
		_, err := o.Write([]byte("hello, " + data.(string) + "\n"))
		return err
	})
	require.NoError(t, w.OK("agent", nil))
	assert.Equal(t, "hello, agent\n", out.String())
}

func TestWriter_Err_JSON_EmitsExitError(t *testing.T) {
	w, out, errBuf := newTestWriter(FormatJSON)
	cliErr := AuthErr("revoked", "re-login", "emk_a1b2")

	got := w.Err(cliErr)

	var ee *ExitError
	require.ErrorAs(t, got, &ee)
	assert.Equal(t, ExitAuth, ee.Code)
	assert.Empty(t, errBuf.String(), "json mode must keep stderr clean")

	var env ErrorEnvelope
	require.NoError(t, json.Unmarshal(out.Bytes(), &env))
	assert.False(t, env.Ok)
	assert.Equal(t, TypeAuth, env.Error.Type)
	assert.Equal(t, "revoked", env.Error.Message)
	assert.Equal(t, "re-login", env.Error.Hint)
	assert.Equal(t, "emk_a1b2", env.Error.Detail["apiKeyPrefix"])
}

func TestWriter_Err_TextEmitsToStderrOnly(t *testing.T) {
	w, out, errBuf := newTestWriter(FormatText)
	cliErr := NotLoggedIn()

	got := w.Err(cliErr)

	var ee *ExitError
	require.ErrorAs(t, got, &ee)
	assert.Equal(t, ExitAuth, ee.Code)
	assert.Empty(t, out.String(), "text-mode failures must keep stdout empty so consumers piping to a file don't get garbage")
	assert.Contains(t, errBuf.String(), "Not logged in")
	assert.Contains(t, errBuf.String(), "evercli auth login")
}

func TestWriter_Err_ClassifiesUnknownError(t *testing.T) {
	w, out, _ := newTestWriter(FormatJSON)
	got := w.Err(errors.New("something went sideways"))

	var ee *ExitError
	require.ErrorAs(t, got, &ee)
	assert.Equal(t, ExitInternal, ee.Code)

	var env ErrorEnvelope
	require.NoError(t, json.Unmarshal(out.Bytes(), &env))
	assert.Equal(t, TypeInternal, env.Error.Type)
	assert.NotEmpty(t, env.Error.Hint)
}

func TestWriter_Err_NilPanics(t *testing.T) {
	w, _, _ := newTestWriter(FormatJSON)
	assert.Panics(t, func() { _ = w.Err(nil) })
}

// (TestWriter_Notice_* retired with the Notice channel.)

func TestResolveFormat_AutoToJSONOffTTY(t *testing.T) {
	var b bytes.Buffer
	got := ResolveFormat(FormatAuto, &b)
	assert.Equal(t, FormatJSON, got, "non-tty buffer must resolve to JSON")
}

func TestParseFormat(t *testing.T) {
	cases := map[string]Format{
		"":     FormatAuto,
		"auto": FormatAuto,
		"text": FormatText,
		"json": FormatJSON,
		"yaml": FormatYAML,
		"yml":  FormatYAML,
		"JSON": FormatJSON,
	}
	for in, want := range cases {
		got, err := ParseFormat(in)
		require.NoError(t, err, "ParseFormat(%q)", in)
		assert.Equal(t, want, got)
	}
	_, err := ParseFormat("xml")
	assert.Error(t, err)
}
