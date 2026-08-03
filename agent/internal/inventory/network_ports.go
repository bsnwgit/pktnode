package inventory

import (
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// collectPorts reports locally listening TCP/UDP ports. This is
// cross-platform via gopsutil (no per-OS shell-outs, unlike firewall
// detection) — it's the data pktSecurity's asset collector needs to score
// exposed-service risk, which the agent has never reported before.
func collectPorts() []PortItem {
	conns, err := net.Connections("inet")
	if err != nil {
		return nil
	}

	// A port bound on multiple local addresses (0.0.0.0 and ::, for example)
	// should only be reported once.
	type portKey struct {
		proto string
		port  uint32
	}
	seen := make(map[portKey]bool)
	nameCache := make(map[int32]string)
	items := make([]PortItem, 0, len(conns))

	for _, c := range conns {
		var proto string
		switch c.Type {
		case 1: // syscall.SOCK_STREAM
			proto = "tcp"
			if c.Status != "LISTEN" {
				continue
			}
		case 2: // syscall.SOCK_DGRAM
			proto = "udp"
			// UDP has no listen state; a bound socket with no remote peer
			// is the closest equivalent to "listening".
			if c.Raddr.Port != 0 {
				continue
			}
		default:
			continue
		}
		if c.Laddr.Port == 0 {
			continue
		}

		key := portKey{proto, c.Laddr.Port}
		if seen[key] {
			continue
		}
		seen[key] = true

		name, ok := nameCache[c.Pid]
		if !ok && c.Pid > 0 {
			if p, err := process.NewProcess(c.Pid); err == nil {
				name, _ = p.Name()
			}
			nameCache[c.Pid] = name
		}

		items = append(items, PortItem{
			Protocol:    proto,
			Port:        int(c.Laddr.Port),
			ProcessName: name,
			PID:         c.Pid,
		})
	}
	return items
}
