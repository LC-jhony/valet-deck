// Command lair is the single entry point for the daemon, the CLI and the
// version shims. Shims call the hidden `exec` subcommand.
package main

import (
	"fmt"
	"os"

	"github.com/lair-sh/lair/internal/cli"
)

func main() {
	if err := cli.Run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "lair: %v\n", err)
		os.Exit(1)
	}
}
