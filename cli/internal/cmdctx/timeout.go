package cmdctx

import (
	"sync"

	"github.com/spf13/cobra"
)

// timeoutAnnotationKey is a marker we set on cmd.Annotations the first
// time BuildDeps registers its PersistentPostRunE wrapper, so a second
// call on the same *cobra.Command knows the wrapper is already installed
// and only appends another cancel func to the per-cmd list.
const timeoutAnnotationKey = "evercli.cmdctx.timeoutWrapperInstalled"

// timeoutCancels is the per-cobra-command list of cancel funcs the
// singleton PostRunE wrapper drains. Keyed by the *cobra.Command pointer
// so two concurrent NewRoot()s in tests don't share state. Access guarded
// by timeoutMu.
var (
	timeoutMu      sync.Mutex
	timeoutCancels = map[*cobra.Command][]func(){}
)

// registerTimeoutCancel installs the singleton PersistentPostRunE
// wrapper (idempotent across BuildDeps re-entries) and appends the
// supplied cancel func to its per-cmd drain list.
//
// Order at run time: the user's original PostRunE (if any) runs FIRST
// — it's the contract teardown handler that may legitimately need a
// live ctx (log flush, telemetry beacon). Only after it returns do we
// invoke every queued cancel and clear the list.
func registerTimeoutCancel(cmd *cobra.Command, cancel func()) {
	if cmd == nil || cancel == nil {
		return
	}

	timeoutMu.Lock()
	defer timeoutMu.Unlock()

	timeoutCancels[cmd] = append(timeoutCancels[cmd], cancel)

	if cmd.Annotations == nil {
		cmd.Annotations = map[string]string{}
	}
	if cmd.Annotations[timeoutAnnotationKey] == "1" {
		// Wrapper already installed; appending the cancel above is all
		// we need. Re-wrapping would capture an already-wrapped closure
		// in `prev` and the first cancel would never fire (regression
		// fix: PostRunE chain leak).
		return
	}
	cmd.Annotations[timeoutAnnotationKey] = "1"

	prev := cmd.PersistentPostRunE
	cmd.PersistentPostRunE = func(c *cobra.Command, args []string) error {
		// Run the user's prior teardown FIRST — they may need a live
		// ctx (drain a long-running stream, flush a final telemetry
		// event). Capturing the error so we still drain cancels even
		// when prev failed.
		var prevErr error
		if prev != nil {
			prevErr = prev(c, args)
		}

		timeoutMu.Lock()
		drained := timeoutCancels[c]
		delete(timeoutCancels, c)
		timeoutMu.Unlock()
		for _, fn := range drained {
			fn()
		}
		return prevErr
	}
}
