package output

// ExitCode is the process exit code returned to the OS.
//
// The set of exit codes is part of EverCli's stable ABI for AI Agents
// (see docs/contracts.md). Six buckets, no more — finer
// grained errors flow through ErrorType in the JSON envelope.
type ExitCode int

const (
	ExitOK         ExitCode = 0   // success
	ExitAPI        ExitCode = 1   // business error (conflict, not_found, upstream, etc.)
	ExitValidation ExitCode = 2   // bad flag / arg
	ExitAuth       ExitCode = 3   // auth failure (not logged in, token invalid/revoked)
	ExitNetwork    ExitCode = 4   // DNS / connection / TLS / timeout
	ExitInternal   ExitCode = 5   // CLI bug
	ExitCancelled  ExitCode = 130 // SIGINT / SIGTERM
)

// ExitError is returned by Writer.Err / Writer.FatalErr from a cobra RunE.
// main.go unwraps it and calls os.Exit with the embedded code. Cobra is
// configured with SilenceErrors+SilenceUsage so this is the only path to
// a non-zero exit.
type ExitError struct {
	Code ExitCode
}

func (e *ExitError) Error() string {
	return "evercli exited with code " + itoa(int(e.Code))
}

// itoa is a tiny strconv replacement to avoid pulling strconv into a hot path.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
