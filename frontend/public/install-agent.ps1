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
    $binaryName = "pktnode-agent-windows-$arch.exe"
    $url = "$($Server.TrimEnd('/'))/agent-releases/$binaryName"
    $tmp = Join-Path $env:TEMP $binaryName

    Write-Host "Downloading $binaryName from $Server..."
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing

    Write-Host "Installing pktNode agent..."
    & $tmp install --server $Server --token $Token

    Remove-Item $tmp -ErrorAction SilentlyContinue
    Write-Host "Done."
}
