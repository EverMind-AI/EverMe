// Package auth registers the `evercli auth` command tree (login /
// logout / status / me). It is the cmd-side glue around internal/auth.
package auth

import (
	"github.com/spf13/cobra"
)

// New returns the parent `evercli auth` command. Sub-commands are
// attached here so cmd/root.go just adds the parent.
func New() *cobra.Command {
	c := &cobra.Command{
		Use:   "auth",
		Short: "Manage EverMe authentication: login, logout, status, me",
	}
	c.AddCommand(newLogin())
	c.AddCommand(newLogout())
	c.AddCommand(newStatus())
	c.AddCommand(newMe())
	return c
}
