package main

// Native OS dialogs, shelled out to platform tooling — there's no real GUI
// toolkit in this tray helper (see the README's tray limitations), so this
// is the same "one-shot native prompt" approach already used for anything
// interactive here. Linux requires zenity (GNOME/most desktop environments
// ship it; a DE without it just won't show the prompt).

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// promptForCode shows a text-entry dialog and returns the entered value.
// ok is false if the user cancelled or the dialog itself failed to run.
func promptForCode() (string, bool) {
	const prompt = "Enter the override code from this node's page in pktNode to stop the agent."

	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(
			`text returned of (display dialog %s default answer "" with title "pktNode — Stop Agent" with icon caution)`,
			quoteAppleScript(prompt),
		)
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return "", false // Cancel button -> non-zero exit
		}
		return strings.TrimSpace(string(out)), true

	case "windows":
		script := fmt.Sprintf(
			`Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox(%s, "pktNode - Stop Agent", "")`,
			quotePowerShell(prompt),
		)
		out, err := exec.Command("powershell", "-NoProfile", "-Command", script).Output()
		if err != nil {
			return "", false
		}
		val := strings.TrimSpace(string(out))
		return val, val != ""

	default: // linux
		out, err := exec.Command("zenity", "--entry",
			"--title=pktNode — Stop Agent", "--text="+prompt).Output()
		if err != nil {
			return "", false // Cancel -> non-zero exit
		}
		return strings.TrimSpace(string(out)), true
	}
}

func showMessage(title, msg string) {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(`display dialog %s with title %s buttons {"OK"} default button "OK"`,
			quoteAppleScript(msg), quoteAppleScript(title))
		exec.Command("osascript", "-e", script).Run()

	case "windows":
		script := fmt.Sprintf(
			`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(%s, %s)`,
			quotePowerShell(msg), quotePowerShell(title),
		)
		exec.Command("powershell", "-NoProfile", "-Command", script).Run()

	default: // linux
		exec.Command("zenity", "--info", "--title="+title, "--text="+msg).Run()
	}
}

// quoteAppleScript wraps s as an AppleScript string literal.
func quoteAppleScript(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

// quotePowerShell wraps s as a PowerShell single-quoted string literal
// (single quotes need no backslash escaping, just doubling any embedded
// single quote).
func quotePowerShell(s string) string {
	return `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
}
