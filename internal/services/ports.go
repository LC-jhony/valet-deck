package services

import (
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
)

// OwnerFunc reports which program listens on a loopback port. It is a
// variable so tests can inject a deterministic implementation.
var OwnerFunc = defaultPortOwner

// PortInUse reports whether a loopback TCP port can be bound.
func PortInUse(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return true
	}
	ln.Close()
	return false
}

// SuggestPort returns the preferred port when free, or the next free port
// above it. The caller then asks OwnerFunc which program holds the old one.
func SuggestPort(preferred int) int {
	for p := preferred; p <= 65535; p++ {
		if !PortInUse(p) {
			return p
		}
	}
	return 0
}

// PortConflict describes an occupied port and its owner.
type PortConflict struct {
	Port       int
	Owner      string
	Suggestion int
}

// CheckPort builds a user-facing conflict description when the port is busy.
func CheckPort(port int) *PortConflict {
	if !PortInUse(port) {
		return nil
	}
	owner := ""
	if OwnerFunc != nil {
		owner = OwnerFunc(port)
	}
	return &PortConflict{
		Port: port, Owner: owner, Suggestion: SuggestPort(port + 1),
	}
}

func (c *PortConflict) String() string {
	who := c.Owner
	if who == "" {
		who = "another program"
	}
	return fmt.Sprintf("port %d is in use by %s; try --port %d", c.Port, who, c.Suggestion)
}

// defaultPortOwner uses `ss -ltnp` when available (best effort). It never
// fails the install: an unknown owner is rendered as "another program".
func defaultPortOwner(port int) string {
	out, err := exec.Command("ss", "-ltnp").Output()
	if err != nil {
		return ""
	}
	needle := ":" + strconv.Itoa(port)
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, needle) {
			continue
		}
		// ss prints users=\"process\",pid=...,fd=...
		if i := strings.Index(line, `users:(("`); i >= 0 {
			rest := line[i+len(`users:(("`):]
			if j := strings.IndexByte(rest, '"'); j > 0 {
				return rest[:j]
			}
		}
	}
	return ""
}
