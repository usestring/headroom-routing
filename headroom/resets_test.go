package headroom

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestResetRecommendations(t *testing.T) {
	data, err := os.ReadFile("testdata/reset-recommendations.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Provider string
		Accounts       []struct {
			ID            string
			ObservedHours int
			Windows       map[string]struct {
				Used  float64
				Reset int
			}
		}
		Offers []struct {
			ID, AccountID string
			Hours         int
			Windows       []string
			RedeemedHours *int
		}
		Want *struct{ ID, Reason string }
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	at := func(hours int) time.Time { return now.Add(time.Duration(hours) * time.Hour) }

	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			readings := make(map[string]Usage, len(tc.Accounts))
			for _, account := range tc.Accounts {
				windows := make(map[string]Window, len(account.Windows))
				for name, window := range account.Windows {
					windows[name] = Window{Utilization: &window.Used, ResetsAt: at(window.Reset)}
				}
				readings[account.ID] = Usage{ObservedAt: at(account.ObservedHours), Windows: windows}
			}
			var offers []ResetOffer
			var want *ResetRecommendation
			for _, fixture := range tc.Offers {
				offer := ResetOffer{
					ID: fixture.ID, AccountID: fixture.AccountID, ExpiresAt: at(fixture.Hours), Windows: fixture.Windows,
				}
				if fixture.RedeemedHours != nil {
					offer.RedeemedAt = at(*fixture.RedeemedHours)
				}
				offers = append(offers, offer)
				if tc.Want != nil && fixture.ID == tc.Want.ID {
					want = &ResetRecommendation{
						OfferID: offer.ID, AccountID: offer.AccountID, ExpiresAt: offer.ExpiresAt, Reason: tc.Want.Reason,
					}
				}
			}
			if tc.Want != nil && want == nil {
				t.Fatalf("fixture has no offer named %q", tc.Want.ID)
			}
			if got := RecommendReset(now, tc.Provider, readings, offers); !reflect.DeepEqual(got, want) {
				t.Fatalf("got %+v, want %+v", got, want)
			}
			for _, account := range tc.Accounts {
				for name, window := range account.Windows {
					if got := *readings[account.ID].Windows[name].Utilization; got != window.Used {
						t.Errorf("%s/%s was changed to %v", account.ID, name, got)
					}
				}
			}
		})
	}
}
