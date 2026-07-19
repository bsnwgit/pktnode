// Package commands executes remote actions queued by the server
// (restart_service, kill_process, run_script, reboot, shutdown) and
// reports back an exit code + captured output. Each OS implements
// execRestartService/execKillProcess/execRunScript/execReboot/execShutdown
// in its own build-tagged file.
package commands

import (
	"encoding/json"
	"fmt"
)

type Result struct {
	Status   string // completed | failed
	ExitCode int
	Output   string
}

func failed(err error) Result {
	return Result{Status: "failed", ExitCode: 1, Output: err.Error()}
}

func completed(output string) Result {
	return Result{Status: "completed", ExitCode: 0, Output: output}
}

// Execute dispatches a queued command by type. Unknown command types and
// malformed payloads are reported back as a failed result rather than
// propagated as an agent-level error — one bad command should never crash
// the check-in loop.
func Execute(commandType string, rawPayload json.RawMessage) Result {
	switch commandType {
	case "restart_service":
		var p struct {
			Service string `json:"service"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.Service == "" {
			return failed(fmt.Errorf("restart_service: missing 'service' in payload"))
		}
		out, err := execRestartService(p.Service)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "kill_process":
		var p struct {
			PID int `json:"pid"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.PID <= 0 {
			return failed(fmt.Errorf("kill_process: missing or invalid 'pid' in payload"))
		}
		out, err := execKillProcess(p.PID)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "run_script":
		var p struct {
			Script string `json:"script"`
		}
		if err := json.Unmarshal(rawPayload, &p); err != nil || p.Script == "" {
			return failed(fmt.Errorf("run_script: missing 'script' in payload"))
		}
		out, err := execRunScript(p.Script)
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "reboot":
		out, err := execReboot()
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	case "shutdown":
		out, err := execShutdown()
		if err != nil {
			return failed(fmt.Errorf("%w: %s", err, out))
		}
		return completed(out)

	default:
		return failed(fmt.Errorf("unknown command_type: %s", commandType))
	}
}
