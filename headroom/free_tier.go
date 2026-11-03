package headroom

import (
	"slices"
	"time"
)

const (
	FreeSuccess = "free_success"
	FreeLimit   = "free_limit"
	PaidSuccess = "paid_success"
	ProbeError  = "error"
)

// FreeTierObservation records the actual billed tier, rather than the model requested before fallback.
type FreeTierObservation struct {
	At      time.Time
	Outcome string
}

// RecoveryInterval bounds recovery after a refusal and by the first subsequent free success.
type RecoveryInterval struct {
	After time.Time
	By    time.Time
}

// FreeTierStanding preserves observed availability without inventing a numerical quota or reset.
// Usable is always false; unknown capacity cannot authorize a scored subscription launch.
type FreeTierStanding struct {
	Availability    string
	ObservedAt      time.Time
	Fresh           bool
	Reason          string
	Usable          bool
	HeadroomPercent *float64
	ResetsAt        time.Time
	Recovery        *RecoveryInterval
}

// AssessFreeTier uses actual observations, independent of the intended probe cadence.
// All observations must refer to one allowance scope; it does not infer session-scoped enforcement.
func AssessFreeTier(observations []FreeTierObservation, now time.Time) FreeTierStanding {
	standing := FreeTierStanding{Availability: "unknown", Reason: "unread"}
	checks := make([]FreeTierObservation, 0, len(observations))
	for _, observation := range observations {
		if observation.At.IsZero() || observation.At.After(now) {
			standing.Reason = "invalid"
			return standing
		}
		switch observation.Outcome {
		case FreeSuccess, FreeLimit, ProbeError:
			checks = append(checks, observation)
		case PaidSuccess:
		default:
			standing.Reason = "invalid"
			return standing
		}
	}
	slices.SortFunc(checks, func(a, b FreeTierObservation) int { return a.At.Compare(b.At) })
	var refusal time.Time
	for index, check := range checks {
		if index > 0 && check.At.Equal(checks[index-1].At) && check.Outcome != checks[index-1].Outcome {
			return FreeTierStanding{Availability: "unknown", Reason: "invalid"}
		}
		if check.Outcome == FreeLimit {
			refusal = check.At
			standing.Recovery = nil
		} else if check.Outcome == FreeSuccess && !refusal.IsZero() && standing.Recovery == nil {
			standing.Recovery = &RecoveryInterval{After: refusal, By: check.At}
		}
	}
	if len(checks) == 0 {
		return standing
	}
	latest := checks[len(checks)-1]
	standing.ObservedAt = latest.At
	standing.Reason = "probe_error"
	switch latest.Outcome {
	case FreeSuccess:
		standing.Availability, standing.Reason = "available", "uncalibrated"
	case FreeLimit:
		standing.Availability, standing.Reason = "exhausted", "limit"
	}
	standing.Fresh = now.Sub(latest.At) <= ObservedFreshness
	if !standing.Fresh {
		standing.Reason = "stale"
	}
	return standing
}
