package headroom

import (
	"maps"
	"math"
	"slices"
	"strings"
	"time"
)

const (
	ResetForExhaustion = "ordinary-quota-exhausted"
	ResetAddsCapacity  = "expiring-reset-adds-weekly-capacity"

	resetPlanningWindow = 7 * 24 * time.Hour
)

// ResetOffer is a single-use offer for an account in the caller's provider pool.
// An empty Windows list covers every allowance on the account.
type ResetOffer struct {
	ID         string
	AccountID  string
	ExpiresAt  time.Time
	Windows    []string
	RedeemedAt time.Time
}

// Clears reports whether the offer resets the named allowance.
func (o ResetOffer) Clears(window string) bool {
	return len(o.Windows) == 0 || slices.Contains(o.Windows, window)
}

// ResetRecommendation explains which offer to redeem and why.
type ResetRecommendation struct {
	OfferID   string
	AccountID string
	ExpiresAt time.Time
	Reason    string
}

// RecommendReset selects the earliest eligible offer for one provider, by
// expiry then ID. Include every compatible route, with an empty Usage for an
// unread route, so it cannot be mistaken for confirmed exhaustion. The Go
// admission policy must pass after clearing the offer's windows. A
// recommendation leaves the readings intact because only a fresh provider
// reading can establish restored capacity.
func RecommendReset(now time.Time, provider string, usage map[string]Usage, offers []ResetOffer) *ResetRecommendation {
	if len(offers) == 0 {
		return nil
	}
	refills := make(map[string]time.Time, len(usage))
	allExhausted := len(usage) > 0
	for account, reading := range usage {
		if !currentResetUsage(reading, now) {
			allExhausted = false
			continue
		}
		var refill time.Time
		for _, window := range reading.Windows {
			if *window.Utilization >= 100 && window.ResetsAt.After(refill) {
				refill = window.ResetsAt
			}
		}
		refills[account] = refill
		allExhausted = allExhausted && !refill.IsZero()
	}

	var best *ResetRecommendation
	for _, offer := range offers {
		refill, current := refills[offer.AccountID]
		if !current || !offer.RedeemedAt.IsZero() || !now.Before(offer.ExpiresAt) {
			continue
		}
		if best != nil && (offer.ExpiresAt.After(best.ExpiresAt) ||
			(offer.ExpiresAt.Equal(best.ExpiresAt) && offer.ID >= best.OfferID)) {
			continue
		}

		reading := usage[offer.AccountID]
		var reason string
		switch {
		case allExhausted:
			reason = ResetForExhaustion
		case !refill.IsZero() && offer.ExpiresAt.Before(refill):
			reason = ResetAddsCapacity
		case refill.IsZero() && offer.ExpiresAt.Sub(now) <= resetPlanningWindow &&
			bridgesWeeklyGap(reading, offer):
			reason = ResetAddsCapacity
		}
		if reason != "" && resetOpensRoute(reading, offer, provider, now) {
			best = &ResetRecommendation{
				OfferID: offer.ID, AccountID: offer.AccountID, ExpiresAt: offer.ExpiresAt, Reason: reason,
			}
		}
	}
	return best
}

func currentResetUsage(u Usage, now time.Time) bool {
	if u.ObservedAt.IsZero() || u.ObservedAt.After(now) || now.Sub(u.ObservedAt) > ObservedFreshness ||
		(!u.ExpiresAt.IsZero() && !u.ExpiresAt.After(now)) {
		return false
	}
	if _, ok := u.Windows[FiveHour]; !ok {
		return false
	}
	if _, ok := u.Windows[SevenDay]; !ok {
		return false
	}
	for _, w := range u.Windows {
		if w.Utilization == nil || math.IsNaN(*w.Utilization) || math.IsInf(*w.Utilization, 0) ||
			*w.Utilization < 0 || (!w.ResetsAt.After(now) && (*w.Utilization > 0 || !w.ResetsAt.IsZero())) {
			return false
		}
	}
	return true
}

func resetOpensRoute(u Usage, offer ResetOffer, provider string, now time.Time) bool {
	u.Windows = maps.Clone(u.Windows)
	zero := 0.0
	eligible := provider != "codex"
	for name, w := range u.Windows {
		if offer.Clears(name) {
			// Codex accepts a manual reset when a covered allowance has less than 80% left.
			eligible = eligible || *w.Utilization > 20
			w.Utilization = &zero
			u.Windows[name] = w
		}
	}
	return eligible && Assess(u, now).Usable
}

// Forecast against the current weekly clock. Redemption can restart that
// clock, so a projected gap is useful only for deciding when to redeem.
func bridgesWeeklyGap(u Usage, offer ResetOffer) bool {
	firstLimit := math.Inf(1)
	clearsFirstLimit := false
	for name, w := range u.Windows {
		if name != SevenDay && !strings.HasPrefix(name, SevenDay+"_") {
			continue
		}
		remaining := w.ResetsAt.Sub(u.ObservedAt)
		elapsed := resetPlanningWindow - remaining
		if *w.Utilization == 0 || elapsed < time.Hour {
			continue
		}
		hoursToLimit := (100 - *w.Utilization) * elapsed.Hours() / *w.Utilization
		if hoursToLimit >= remaining.Hours() {
			continue
		}
		if hoursToLimit <= offer.ExpiresAt.Sub(u.ObservedAt).Hours() {
			return false
		}
		switch {
		case hoursToLimit < firstLimit:
			firstLimit, clearsFirstLimit = hoursToLimit, offer.Clears(name)
		case hoursToLimit == firstLimit:
			clearsFirstLimit = clearsFirstLimit && offer.Clears(name)
		}
	}
	return clearsFirstLimit
}
