// pktNode agent — enrolls with a pktNode server, then checks in on an
// interval reporting inventory and executing queued remote actions.
//
// Usage:
//
//	pktnode-agent install --server https://pktnode.example.com --token <enrollment-token>
//	pktnode-agent uninstall
//	pktnode-agent run       (invoked by the OS service manager; not for direct use)
//	pktnode-agent version
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"

	"pktnode-agent/internal/agentloop"
	"pktnode-agent/internal/config"
	"pktnode-agent/internal/inventory"
	"pktnode-agent/internal/svcinstall"
	"pktnode-agent/internal/svcrun"
	"pktnode-agent/internal/totp"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "install":
		runInstall(os.Args[2:])
	case "uninstall":
		runUninstall(os.Args[2:])
	case "unlock":
		runUnlock(os.Args[2:])
	case "run":
		runForeground()
	case "version":
		fmt.Println("pktNode agent " + inventory.AgentVersion)
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `pktNode agent

Usage:
  pktnode-agent install --server <url> --token <enrollment-token>
  pktnode-agent uninstall --unlock-code <code>
  pktnode-agent unlock <code>
  pktnode-agent run
  pktnode-agent version

"unlock" and "uninstall --unlock-code" both take the live override code
shown to an admin on this node's detail page in the pktNode UI. "unlock"
grants a short (2 minute) window to stop the service via the OS service
manager (systemctl/launchctl/Stop-Service) without a code check built
into that path itself.
`)
}

func runInstall(args []string) {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	server := fs.String("server", "", "pktNode server URL, e.g. https://pktnode.example.com")
	token := fs.String("token", "", "Enrollment token from Settings -> Enrollment")
	fs.Parse(args)

	if *server == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "install requires --server and --token")
		fs.Usage()
		os.Exit(2)
	}

	fmt.Println("Enrolling with", *server, "...")
	if err := agentloop.Enroll(*server, *token); err != nil {
		log.Fatalf("enrollment failed: %v", err)
	}
	fmt.Println("Enrolled successfully.")

	installPath := svcinstall.InstallPath()
	if err := copySelf(installPath); err != nil {
		log.Fatalf("failed to install binary to %s: %v", installPath, err)
	}
	fmt.Println("Installed binary to", installPath)

	if err := svcinstall.Install(installPath); err != nil {
		log.Fatalf("failed to install service: %v", err)
	}
	fmt.Println("Service installed and started. pktNode agent is now running.")

	installTrayIfPresent()
}

// installTrayIfPresent looks for a "pktnode-tray" binary sitting next to
// this installer (the install-agent.sh/.ps1 scripts download it alongside
// the agent when a tray build exists for this OS/arch) and, if found,
// installs it as a per-user-session status icon. Not every platform has
// one yet (see README) — this is entirely best-effort and never fails
// the overall install.
func installTrayIfPresent() {
	self, err := os.Executable()
	if err != nil {
		return
	}
	trayName := "pktnode-tray"
	if runtime.GOOS == "windows" {
		trayName = "pktnode-tray.exe"
	}
	sibling := filepath.Join(filepath.Dir(self), trayName)
	if _, err := os.Stat(sibling); err != nil {
		return // no tray build for this platform — silently skip
	}

	trayInstallPath := svcinstall.TrayInstallPath()
	if err := copyFile(sibling, trayInstallPath); err != nil {
		log.Printf("warning: found a tray binary but failed to install it: %v", err)
		return
	}
	if err := svcinstall.InstallTray(trayInstallPath); err != nil {
		log.Printf("warning: failed to register the tray status icon: %v", err)
		return
	}
	fmt.Println("Installed status icon to", trayInstallPath, "(shows up next time you log in)")
}

func runUnlock(args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: pktnode-agent unlock <code>")
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("%v", err)
	}
	if cfg.OverrideSecret == "" {
		log.Fatal("this node has no override secret (enrolled before tamper-lockout support was added — re-enroll to get one)")
	}
	if !totp.Verify(cfg.OverrideSecret, args[0]) {
		log.Fatal("incorrect or expired override code")
	}
	if err := config.WriteUnlockGrant(); err != nil {
		log.Fatalf("failed to record unlock: %v", err)
	}
	fmt.Printf("Unlocked for %s — stop/restart the service now via the normal OS service manager.\n", config.UnlockGrantMaxAge)
}

func runUninstall(args []string) {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	code := fs.String("unlock-code", "", "Override code from this node's detail page in the pktNode UI")
	fs.Parse(args)

	cfg, err := config.Load()
	switch {
	case err == config.ErrNotEnrolled:
		// Nothing enrolled to protect — proceed (e.g. cleaning up a
		// partial/broken install).
	case err != nil:
		log.Fatalf("%v", err)
	case cfg.OverrideSecret == "":
		// Enrolled before tamper-lockout existed — nothing to check
		// against, don't block a legitimate uninstall on a gap that
		// isn't the user's fault.
	default:
		if *code == "" || !totp.Verify(cfg.OverrideSecret, *code) {
			log.Fatal("uninstall requires --unlock-code with the current override code from this node's detail page in the pktNode UI")
		}
	}

	_ = svcinstall.UninstallTray() // best-effort, don't block on it
	if err := svcinstall.Uninstall(); err != nil {
		log.Fatalf("failed to uninstall service: %v", err)
	}
	fmt.Println("Service removed. Local config left at", config.Path(), "— delete it manually if you want a clean re-enroll.")
}

func runForeground() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("pktnode-agent: ")
	if err := svcrun.Run(); err != nil {
		log.Fatalf("agent stopped: %v", err)
	}
}

// copySelf copies the currently running executable to dest, creating
// parent directories as needed. Used so the service points at a stable
// path instead of wherever the installer happened to be run from.
func copySelf(dest string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self == dest {
		return nil
	}
	return copyFile(self, dest)
}

// copyFile copies src to dest (mode 0755), creating parent directories
// as needed.
func copyFile(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}
