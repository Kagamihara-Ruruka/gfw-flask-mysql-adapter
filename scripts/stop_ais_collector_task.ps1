$ErrorActionPreference = "Stop"
$taskName = "RRKAL AIS Collector"
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$pidFile = Join-Path $repo "ais_ingest_pid.json"
if (Test-Path -LiteralPath $pidFile) {
  try {
    $raw = Get-Content -Raw -LiteralPath $pidFile | ConvertFrom-Json
    $pid = [int]$raw.pid
    if ($pid -gt 0) {
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

Write-Output "stopped:$taskName"
