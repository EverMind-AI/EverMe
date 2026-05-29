package output

import "testing"

func TestErrorTypeExitCode(t *testing.T) {
	cases := []struct {
		typ  ErrorType
		want ExitCode
	}{
		{TypeInvalidArgs, ExitValidation},
		{TypeNotLoggedIn, ExitAuth},
		{TypeAuth, ExitAuth},
		{TypeNetwork, ExitNetwork},
		{TypeUpstream, ExitAPI},
		{TypeConflict, ExitAPI},
		{TypeNotFound, ExitAPI},
		{TypeRateLimit, ExitAPI},
		{TypePermission, ExitAPI},
		{TypePluginNotDetected, ExitAPI},
		{TypeIO, ExitInternal},
		{TypeCancelled, ExitCancelled},
		{TypeInternal, ExitInternal},
	}
	for _, c := range cases {
		if got := c.typ.ExitCode(); got != c.want {
			t.Errorf("%s.ExitCode() = %d, want %d", c.typ, got, c.want)
		}
	}
}

func TestExitErrorMessage(t *testing.T) {
	e := &ExitError{Code: ExitAuth}
	if e.Error() == "" {
		t.Fatal("ExitError.Error() returned empty string")
	}
}
