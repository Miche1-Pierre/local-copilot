<#
.SYNOPSIS
  Hardens Ollama for local-only use on Windows (run it yourself; nothing here runs automatically).

.DESCRIPTION
  -Apply       binds Ollama to 127.0.0.1 and disables its cloud features (user environment variables),
               then restarts Ollama so the change takes effect.
  -BlockNet    adds a Windows Firewall rule blocking OUTBOUND traffic of ollama.exe (needs an
               elevated prompt). `ollama pull` stops working until you run -UnblockNet.
  -UnblockNet  removes that firewall rule (to download models again).
  -Status      shows the current state (default).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\ollama-local-only.ps1 -Status
#>
param(
  [switch]$Apply,
  [switch]$BlockNet,
  [switch]$UnblockNet,
  [switch]$Status
)

$ruleName = 'Ollama - block outbound (Local Copilot)'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'

function Show-Status {
  $hostVar = [Environment]::GetEnvironmentVariable('OLLAMA_HOST', 'User')
  $noCloud = [Environment]::GetEnvironmentVariable('OLLAMA_NO_CLOUD', 'User')
  Write-Host "OLLAMA_HOST (user)     : $(if ($hostVar) { $hostVar } else { '<unset> = 127.0.0.1:11434' })"
  Write-Host "OLLAMA_NO_CLOUD (user) : $(if ($noCloud) { $noCloud } else { '<unset>' })"
  $listen = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress -Unique
  Write-Host "Listening on           : $(if ($listen) { $listen -join ', ' } else { 'not running' })"
  $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Write-Host "Outbound firewall block: $(if ($rule) { 'ON' } else { 'off' })"
}

if ($Apply) {
  [Environment]::SetEnvironmentVariable('OLLAMA_HOST', '127.0.0.1:11434', 'User')
  [Environment]::SetEnvironmentVariable('OLLAMA_NO_CLOUD', '1', 'User')
  Write-Host 'Set OLLAMA_HOST=127.0.0.1:11434 and OLLAMA_NO_CLOUD=1 for your user.'
  Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force
  $app = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama app.exe'
  if (Test-Path $app) { Start-Process $app; Write-Host 'Ollama restarted.' } else { Write-Host 'Start Ollama again to apply.' }
}

if ($BlockNet) {
  if (-not (Test-Path $exe)) { throw "ollama.exe not found at $exe" }
  New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Program $exe -Action Block -Profile Any | Out-Null
  Write-Host "Outbound traffic of $exe is now blocked (run -UnblockNet before 'ollama pull')."
}

if ($UnblockNet) {
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Write-Host 'Outbound block removed.'
}

if ($Status -or -not ($Apply -or $BlockNet -or $UnblockNet)) { Show-Status }
