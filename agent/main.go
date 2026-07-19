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

	"pktnode-agent/internal/agentloop"
	"pktnode-agent/internal/config"
	"pktnode-agent/internal/inventory"
	"pktnode-agent/internal/svcinstall"
	"pktnode-agent/internal/svcrun"
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
		runUninstall()
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
  pktnode-agent uninstall
  pktnode-agent run
  pktnode-agent version
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
}

func runUninstall() {
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

	if err := os.MkdirAll(dirOf(dest), 0o755); err != nil {
		return err
	}

	src, err := os.Open(self)
	if err != nil {
		return err
	}
	defer src.Close()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, src); err != nil {
		return err
	}
	return out.Close()
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[:i]
		}
	}
	return "."
}
