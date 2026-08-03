// Package speedtest runs an M-Lab NDT7 speed test — no API key, no
// bundled external binary (unlike Ookla's CLI), just a Go client compiled
// into the agent. A nearest server is auto-discovered via M-Lab's public
// Locate API. Only one test runs at a time across the whole agent; a
// second caller while one is in flight gets ErrAlreadyRunning immediately
// instead of queueing behind it.
package speedtest

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	ndt7 "github.com/m-lab/ndt7-client-go"
	"github.com/m-lab/ndt7-client-go/spec"
)

var running atomic.Bool

// ErrAlreadyRunning is returned without touching the network when a test
// is already in flight — the caller decides how to report that (a queued
// command reports it as a failed result; the scheduled ticker just skips
// the cycle and tries again next time).
var ErrAlreadyRunning = errors.New("a speed test is already running on this node")

type Result struct {
	Status       string  `json:"status"` // completed | failed
	DownloadMbps float64 `json:"download_mbps,omitempty"`
	UploadMbps   float64 `json:"upload_mbps,omitempty"`
	// LatencyMs/JitterMs come from the M-Lab server's own TCP_INFO
	// instrumentation (relayed to the client over the ndt7 websocket
	// during the download test), not a local measurement — so these are
	// populated regardless of the agent's own OS, but are omitted
	// (zero/absent) if the server didn't report TCPInfo for some reason.
	LatencyMs  float64 `json:"latency_ms,omitempty"`
	JitterMs   float64 `json:"jitter_ms,omitempty"`
	ServerFQDN string  `json:"server_fqdn,omitempty"`
	Error      string  `json:"error,omitempty"`
}

func failResult(err error) Result {
	return Result{Status: "failed", Error: err.Error()}
}

// Run performs a download+upload NDT7 test. clientVersion is reported to
// the M-Lab server as part of the client identity string, purely for their
// own usage stats — pass the agent's own version.
func Run(ctx context.Context, clientVersion string) (Result, error) {
	if !running.CompareAndSwap(false, true) {
		return Result{}, ErrAlreadyRunning
	}
	defer running.Store(false)

	client := ndt7.NewClient("pktnode-agent", clientVersion)

	dlCtx, dlCancel := context.WithTimeout(ctx, 30*time.Second)
	dlCh, err := client.StartDownload(dlCtx)
	if err != nil {
		dlCancel()
		return failResult(err), nil
	}
	for range dlCh {
	}
	dlCancel()

	ulCtx, ulCancel := context.WithTimeout(ctx, 30*time.Second)
	ulCh, err := client.StartUpload(ulCtx)
	if err != nil {
		ulCancel()
		return failResult(err), nil
	}
	for range ulCh {
	}
	ulCancel()

	res := Result{Status: "completed", ServerFQDN: client.FQDN}
	results := client.Results()

	if dl := results[spec.TestDownload]; dl != nil {
		if dl.Client.AppInfo != nil && dl.Client.AppInfo.ElapsedTime > 0 {
			// Mbps = bits / (ElapsedTime microseconds as seconds) / 1e6,
			// which reduces to NumBytes*8/ElapsedTime when ElapsedTime is
			// already in microseconds.
			res.DownloadMbps = 8 * float64(dl.Client.AppInfo.NumBytes) / float64(dl.Client.AppInfo.ElapsedTime)
		}
		if dl.Server.TCPInfo != nil {
			res.LatencyMs = float64(dl.Server.TCPInfo.RTT) / 1000
			res.JitterMs = float64(dl.Server.TCPInfo.RTTVar) / 1000
		}
	}
	if ul := results[spec.TestUpload]; ul != nil && ul.Client.AppInfo != nil && ul.Client.AppInfo.ElapsedTime > 0 {
		res.UploadMbps = 8 * float64(ul.Client.AppInfo.NumBytes) / float64(ul.Client.AppInfo.ElapsedTime)
	}

	return res, nil
}
