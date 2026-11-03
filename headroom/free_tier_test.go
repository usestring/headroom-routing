package headroom

import (
	"reflect"
	"testing"
	"time"
)

func TestFreeTierRecoveryUsesActualFreeObservations(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	success := start.Add(180 * time.Minute)
	observations := []FreeTierObservation{
		{At: success.Add(time.Minute), Outcome: FreeSuccess},
		{At: success, Outcome: FreeSuccess},
		{At: start.Add(20 * time.Minute), Outcome: PaidSuccess},
		{At: start, Outcome: FreeLimit},
	}
	before := append([]FreeTierObservation(nil), observations...)
	standing := AssessFreeTier(observations, success.Add(time.Minute))
	if standing.Availability != "available" || !standing.Fresh || standing.Reason != "uncalibrated" {
		t.Fatalf("unexpected recovery standing: %+v", standing)
	}
	if standing.Usable || standing.HeadroomPercent != nil || !standing.ResetsAt.IsZero() {
		t.Fatalf("observations invented a routable quota: %+v", standing)
	}
	if standing.Recovery == nil || !standing.Recovery.After.Equal(start) || !standing.Recovery.By.Equal(success) {
		t.Fatalf("recovery must use the first free success, not paid fallback: %+v", standing.Recovery)
	}
	if !reflect.DeepEqual(observations, before) {
		t.Fatal("assessment changed the caller's history")
	}
}

func TestFreeTierUnavailableEvidence(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	success := start.Add(180 * time.Minute)
	for _, test := range []struct {
		name         string
		observations []FreeTierObservation
		now          time.Time
		availability string
		reason       string
	}{
		{"paid fallback", []FreeTierObservation{{At: start, Outcome: FreeLimit}, {At: success, Outcome: PaidSuccess}}, success, "exhausted", "stale"},
		{"error", []FreeTierObservation{{At: start, Outcome: FreeLimit}, {At: success, Outcome: ProbeError}}, success, "unknown", "probe_error"},
		{"paid only", []FreeTierObservation{{At: success, Outcome: PaidSuccess}}, success, "unknown", "unread"},
		{"new refusal", []FreeTierObservation{{At: start, Outcome: FreeLimit}, {At: success, Outcome: FreeSuccess}, {At: success.Add(time.Second), Outcome: FreeLimit}}, success.Add(time.Second), "exhausted", "limit"},
		{"stale success", []FreeTierObservation{{At: success, Outcome: FreeSuccess}}, success.Add(ObservedFreshness + time.Second), "available", "stale"},
		{"future", []FreeTierObservation{{At: success.Add(time.Second), Outcome: FreeSuccess}}, success, "unknown", "invalid"},
		{"zero time", []FreeTierObservation{{Outcome: FreeLimit}}, success, "unknown", "invalid"},
		{"unknown outcome", []FreeTierObservation{{At: start, Outcome: "unknown"}}, success, "unknown", "invalid"},
		{"conflicting time", []FreeTierObservation{{At: start, Outcome: FreeLimit}, {At: start, Outcome: FreeSuccess}}, success, "unknown", "invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			standing := AssessFreeTier(test.observations, test.now)
			if standing.Availability != test.availability || standing.Reason != test.reason || standing.Usable || standing.Recovery != nil {
				t.Fatalf("unexpected evidence assessment: %+v", standing)
			}
		})
	}
}
