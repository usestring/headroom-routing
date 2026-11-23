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

func TestResetForecastSubscriptionExpiration(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name      string
		expiresAt time.Time
		want      bool
	}{
		{name: "before exhaustion", expiresAt: now.Add(12 * time.Hour)},
		{name: "at exhaustion", expiresAt: now.Add(42 * time.Hour)},
		{name: "after exhaustion", expiresAt: now.Add(48 * time.Hour), want: true},
		{name: "no fixed expiration", want: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			short, weekly := 10.0, 72.0
			reading := Usage{
				ObservedAt: now, ExpiresAt: tc.expiresAt,
				Windows: map[string]Window{
					FiveHour: {Utilization: &short, ResetsAt: now.Add(3 * time.Hour)},
					SevenDay: {Utilization: &weekly, ResetsAt: now.Add(60 * time.Hour)},
				},
			}
			offer := ResetOffer{ID: "reset", AccountID: "account", ExpiresAt: now.Add(24 * time.Hour)}
			got := RecommendReset(now, "claude", map[string]Usage{"account": reading}, []ResetOffer{offer})
			if (got != nil) != tc.want {
				t.Fatalf("got %+v, want recommendation: %v", got, tc.want)
			}
		})
	}
}

func TestResetForecastCustomWeeklyWindow(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name    string
		windows []string
		want    bool
	}{
		{name: "all windows", want: true},
		{name: "custom weekly window", windows: []string{"model_weekly"}, want: true},
		{name: "uncovered custom window", windows: []string{SevenDay}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			short, weekly, model := 10.0, 10.0, 72.0
			reading := Usage{
				ObservedAt: now,
				Windows: map[string]Window{
					FiveHour:       {Utilization: &short, ResetsAt: now.Add(3 * time.Hour)},
					SevenDay:       {Utilization: &weekly, ResetsAt: now.Add(60 * time.Hour)},
					"model_weekly": {Utilization: &model, ResetsAt: now.Add(60 * time.Hour)},
				},
			}
			offer := ResetOffer{
				ID: "reset", AccountID: "account", ExpiresAt: now.Add(24 * time.Hour), Windows: tc.windows,
			}
			got := RecommendReset(now, "claude", map[string]Usage{"account": reading}, []ResetOffer{offer})
			if (got != nil) != tc.want {
				t.Fatalf("got %+v, want recommendation: %v", got, tc.want)
			}
		})
	}
}
