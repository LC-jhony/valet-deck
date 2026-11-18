// Package version implements the resolution rules shared by PHP, Node and the
// downloadable services:
//
//   - an exact version (22.11.0) resolves to the newest available version that
//     shares its major line, unless the exact version itself is available;
//   - a "major" request (22) resolves to the newest version in that major;
//   - versions are compared with a small semver parser (no external module).
package version

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Version is a parsed semantic version with an optional build number suffix.
type Version struct {
	Major, Minor, Patch int
	Build               int // 0 when the version has no +build<N> suffix
	Raw                 string
}

// Parse accepts "8.4.3", "22", "8.4.3+N2" and leading "v"/"php-".
func Parse(s string) (Version, error) {
	raw := strings.TrimSpace(s)
	raw = strings.TrimPrefix(raw, "v")
	build := 0
	if i := strings.Index(raw, "+"); i >= 0 {
		bs := raw[i+1:]
		raw = raw[:i]
		bs = strings.TrimPrefix(strings.ToUpper(bs), "N")
		if n, err := strconv.Atoi(bs); err == nil {
			build = n
		}
	}
	if i := strings.Index(raw, "-"); i >= 0 {
		raw = raw[:i]
	}
	parts := strings.Split(raw, ".")
	for len(parts) < 3 {
		parts = append(parts, "0")
	}
	if len(parts) > 3 {
		return Version{}, fmt.Errorf("invalid version %q", s)
	}
	nums := make([]int, 3)
	for i := range parts {
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 {
			return Version{}, fmt.Errorf("invalid version %q", s)
		}
		nums[i] = n
	}
	v := Version{Major: nums[0], Minor: nums[1], Patch: nums[2], Build: build, Raw: strings.TrimSpace(s)}
	return v, nil
}

// Compare returns -1, 0 or 1 following semver order (build suffix is a
// tie-breaker after patch).
func (v Version) Compare(o Version) int {
	for _, pair := range [][2]int{{v.Major, o.Major}, {v.Minor, o.Minor}, {v.Patch, o.Patch}, {v.Build, o.Build}} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	return 0
}

// Major returns the major line key ("8", "22").
func (v Version) MajorLine() string { return strconv.Itoa(v.Major) }

// MinorLine returns the minor key used by PHP ("8.4").
func (v Version) MinorLine() string { return fmt.Sprintf("%d.%d", v.Major, v.Minor) }

// SortNewest sorts in descending version order.
func SortNewest(versions []string) {
	parsed := make([]Version, len(versions))
	raw := make(map[string]Version, len(versions))
	for i, s := range versions {
		v, err := Parse(s)
		if err != nil {
			continue
		}
		parsed[i] = v
		raw[s] = v
	}
	sort.SliceStable(versions, func(i, j int) bool {
		return raw[versions[i]].Compare(raw[versions[j]]) > 0
	})
}

// LatestInMajor returns the newest available version whose major matches the
// request. "22.11.0" and "22" both resolve inside major 22.
func LatestInMajor(request string, available []string) (string, error) {
	req, err := Parse(request)
	if err != nil {
		return "", err
	}
	var best string
	var bestV Version
	found := false
	for _, s := range available {
		v, err := Parse(s)
		if err != nil || v.Major != req.Major {
			continue
		}
		if !found || v.Compare(bestV) > 0 {
			best, bestV, found = s, v, true
		}
	}
	if !found {
		return "", fmt.Errorf("no version available for major %d (requested %q)", req.Major, request)
	}
	return best, nil
}

// ExactOrLatest returns the exact request when it is present verbatim,
// otherwise the newest in its major line.
func ExactOrLatest(request string, available []string) (string, error) {
	for _, s := range available {
		if s == request {
			return s, nil
		}
	}
	return LatestInMajor(request, available)
}

// IsMinorLine reports whether s looks like "8.4" (a PHP minor line).
func IsMinorLine(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 2 {
		return false
	}
	for _, p := range parts {
		if _, err := strconv.Atoi(p); err != nil {
			return false
		}
	}
	return true
}
