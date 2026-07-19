# pktNode agent installer — Windows
# Usage: iwr <server>/install-agent.ps1 -UseBasicParsing | iex; Install-PktNodeAgent -Server "<server>" -Token "<enrollment-token>"

function Install-PktNodeAgent {
    param(
        [Parameter(Mandatory = $true)][string]$Server,
        [Parameter(Mandatory = $true)][string]$Token
    )
    $ErrorActionPreference = 'Stop'

    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Error "This installer must run in an elevated (Administrator) PowerShell session."
        return
    }

    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $tmpDir = Join-Path $env:TEMP "pktnode-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir | Out-Null

    $binaryName = "pktnode-agent-windows-$arch.exe"
    $agentPath = Join-Path $tmpDir "pktnode-agent.exe"
    Write-Host "Downloading $binaryName from $Server..."
    Invoke-WebRequest -Uri "$($Server.TrimEnd('/'))/agent-releases/$binaryName" -OutFile $agentPath -UseBasicParsing

    # Tray status icon — best-effort, not every arch has one built (see
    # agent/build.sh). Named as a fixed sibling filename so the agent
    # binary can find it regardless of which arch build it came from.
    $trayBinaryName = "pktnode-tray-windows-$arch.exe"
    $trayPath = Join-Path $tmpDir "pktnode-tray.exe"
    try {
        Invoke-WebRequest -Uri "$($Server.TrimEnd('/'))/agent-releases/$trayBinaryName" -OutFile $trayPath -UseBasicParsing
        Write-Host "Downloaded status icon helper."
    } catch {
        # No tray build for this arch — fine, the agent installs without it.
    }

    Write-Host "Installing pktNode agent..."
    & $agentPath install --server $Server --token $Token

    Remove-Item $tmpDir -Recurse -ErrorAction SilentlyContinue
    Write-Host "Done."
}
