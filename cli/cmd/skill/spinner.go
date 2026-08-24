package skill

import (
	"fmt"
	"os"
	"time"
)

var spinnerFrames = []string{"⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"}

// startSpinner writes an animated spinner to stderr.
// Call the returned stop function to clear the spinner line when done.
func startSpinner(msg string) func() {
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		i := 0
		t := time.NewTicker(80 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-done:
				fmt.Fprintf(os.Stderr, "\r\033[2K") // clear current line
				return
			case <-t.C:
				fmt.Fprintf(os.Stderr, "\r  %s %s", spinnerFrames[i%len(spinnerFrames)], msg)
				i++
			}
		}
	}()
	return func() {
		close(done)
		<-stopped
	}
}
