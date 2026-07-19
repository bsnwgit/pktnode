package totp

import "testing"

// codeAt is a test-only helper that computes the code for an arbitrary
// unix timestamp, so this cross-checks against the Python server's
// implementation at fixed, known instants instead of "whatever now is".
func codeAt(secret string, unixSec int64) (string, error) {
	return code(secret, uint64(unixSec/stepSeconds))
}

func TestKnownVectors(t *testing.T) {
	// Cross-checked against an independent Python implementation of the
	// same algorithm (app/api/override.py uses the same secret/timestamp
	// pairs) — both produced identical codes before these were pinned here.
	const secret = "JBSWY3DPEHPK3PXP"
	cases := map[int64]string{
		0:          "282760",
		59:         "996554",
		1234567890: "742275",
		2000000000: "890699",
	}
	for ts, want := range cases {
		got, err := codeAt(secret, ts)
		if err != nil {
			t.Fatalf("codeAt(%d): %v", ts, err)
		}
		if got != want {
			t.Errorf("codeAt(%d) = %s, want %s", ts, got, want)
		}
	}
}

func TestVerifyRoundTrip(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	c, err := CurrentCode(secret)
	if err != nil {
		t.Fatal(err)
	}
	if !Verify(secret, c) {
		t.Fatal("Verify rejected a just-generated current code")
	}
	if Verify(secret, "000000") {
		t.Fatal("Verify accepted an arbitrary wrong code (extremely unlikely unless broken)")
	}
}
