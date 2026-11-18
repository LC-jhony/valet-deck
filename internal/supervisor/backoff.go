package supervisor

import "time"

// Backoff implements capped exponential backoff for restarts.
type Backoff struct {
	Base    time.Duration
	Max     time.Duration
	Factor  float64
	attempt int
}

// Next returns the delay before the next restart and advances the counter.
func (b *Backoff) Next() time.Duration {
	base := b.Base
	if base <= 0 {
		base = time.Second
	}
	max := b.Max
	if max <= 0 {
		max = time.Minute
	}
	factor := b.Factor
	if factor <= 0 {
		factor = 2
	}
	d := float64(base)
	for i := 0; i < b.attempt; i++ {
		d *= factor
		if d >= float64(max) {
			return max
		}
	}
	b.attempt++
	if d > float64(max) {
		return max
	}
	return time.Duration(d)
}

// Reset clears the failure counter after a healthy run.
func (b *Backoff) Reset() { b.attempt = 0 }
