$ErrorActionPreference = "Stop"
$env:PYTHONUTF8 = "1"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location -LiteralPath $repo

$python = Join-Path $repo ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
  throw "Python venv not found: $python"
}

if ([string]::IsNullOrWhiteSpace($env:RRKAL_AIS_MYSQL_PASSWORD)) {
  throw "RRKAL_AIS_MYSQL_PASSWORD is not set in the task environment."
}

$logDir = Join-Path $repo "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdout = Join-Path $logDir "ais_collector_task_stdout.log"
$stderr = Join-Path $logDir "ais_collector_task_stderr.log"
"[$stamp] starting AIS collector" | Out-File -FilePath $stdout -Encoding utf8 -Append

& $python core.py --config config\adapter.local.json ingest-ais --collector-config config\ais_collector.local.json 1>> $stdout 2>> $stderr
