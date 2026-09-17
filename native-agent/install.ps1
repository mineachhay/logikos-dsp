<#
.SYNOPSIS
    Installs the logikos-dsp agent as a Windows service.

.DESCRIPTION
    Copies the agent and its CA certificate into Program Files, writes
    agent.json, and registers a service that starts with Windows and restarts
    itself on failure.

    Run it with no arguments to be prompted for each setting, or pass them all
    to install unattended — which is what you want for more than a machine or
    two (GPO startup script, Intune, PsExec, a deployment tool).

.EXAMPLE
    .\install.ps1

    Prompts for everything.

.EXAMPLE
    .\install.ps1 -ServerUrl "https://dsp.logikos.dev/api" -ConnectIp "20.20.0.92" `
                  -EnrollToken "abc123..." -WatchPath "C:\Users\jdoe\Downloads"

    Unattended.

.NOTES
    The enroll token is written to agent.json in plaintext, readable by local
    administrators. It is a deployment-wide credential: anyone holding it can
    register an agent. Treat the install command line accordingly — it lands in
    PowerShell history — and prefer passing it from a protected deployment
    system rather than typing it on shared machines.
#>
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [string]$EnrollToken,
    [string]$WatchPath,

    # Dial this address instead of resolving ServerUrl's hostname, while still
    # verifying the certificate against that hostname. Use it to reach a server
    # on your own network instead of going out through a CDN and back.
    [string]$ConnectIp,

    # PEM file holding a CA to trust in addition to the system roots. Required
    # when the server's certificate is issued by a private CA — Cloudflare's
    # Origin CA, for instance, which Windows does not ship.
    [string]$CaCertFile = "cloudflare-origin-ca.pem",

    [string]$InstallDir = "$env:ProgramFiles\logikos-dsp-agent"
)

$ErrorActionPreference = "Stop"

function Require-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this from an elevated PowerShell — installing a service needs administrator rights."
    }
}

function Get-Setting($value, $prompt, $default) {
    if ($value) { return $value }
    if ($default) {
        $entered = Read-Host "$prompt [$default]"
        if ([string]::IsNullOrWhiteSpace($entered)) { return $default }
        return $entered
    }
    do {
        $entered = Read-Host $prompt
    } while ([string]::IsNullOrWhiteSpace($entered))
    return $entered
}

Require-Administrator

$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$agentExe = Join-Path $source "agent.exe"
if (-not (Test-Path $agentExe)) {
    throw "agent.exe was not found next to this script ($source)."
}

$ServerUrl   = Get-Setting $ServerUrl   "DSP server URL"                      "https://dsp.logikos.dev/api"
$ConnectIp   = Get-Setting $ConnectIp   "Server IP on your network (optional, Enter to skip)" " "
$EnrollToken = Get-Setting $EnrollToken "Agent enroll token"                  $null
$WatchPath   = Get-Setting $WatchPath   "Folder to watch"                     "$env:USERPROFILE\Downloads"
if ($ConnectIp -eq " ") { $ConnectIp = "" }

if (-not (Test-Path $WatchPath)) {
    throw "The folder to watch does not exist: $WatchPath"
}

# Stop an existing service before overwriting its executable, or the copy
# fails with a file-in-use error that reads like a permissions problem.
$existing = Get-Service -Name "logikos-dsp-agent" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing the existing service first..."
    & (Join-Path $InstallDir "agent.exe") uninstall 2>$null | Out-Null
    Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $agentExe -Destination $InstallDir -Force

$config = [ordered]@{
    serverUrl   = $ServerUrl
    enrollToken = $EnrollToken
    watchPath   = $WatchPath
}
if ($ConnectIp) { $config["connectIp"] = $ConnectIp }

$caSource = Join-Path $source $CaCertFile
if (Test-Path $caSource) {
    Copy-Item $caSource -Destination $InstallDir -Force
    $config["caCertFile"] = (Split-Path -Leaf $CaCertFile)
} elseif ($CaCertFile -and $CaCertFile -ne "cloudflare-origin-ca.pem") {
    throw "The CA file was not found: $caSource"
}

$configPath = Join-Path $InstallDir "agent.json"
$config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8

# The token is in this file, so keep it to administrators and SYSTEM rather
# than leaving it readable by every user of the machine.
$acl = Get-Acl $configPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($account in @("BUILTIN\Administrators", "NT AUTHORITY\SYSTEM")) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($account, "FullControl", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl -Path $configPath -AclObject $acl

Write-Host ""
Write-Host "Installing the service..."
& (Join-Path $InstallDir "agent.exe") install
if ($LASTEXITCODE -ne 0) {
    throw "The agent failed to install. Check $InstallDir\agent.log."
}

Write-Host ""
Write-Host "Installed to $InstallDir"
Write-Host "Watching      $WatchPath"
Write-Host "Reporting to  $ServerUrl$(if ($ConnectIp) { " (via $ConnectIp)" })"
Write-Host ""
Write-Host "Check on it later with:"
Write-Host "  & '$InstallDir\agent.exe' status"
Write-Host "  Get-Content '$InstallDir\agent.log' -Tail 20"
Write-Host "Remove it with:"
Write-Host "  & '$InstallDir\agent.exe' uninstall"
