$ErrorActionPreference = "Stop"
$taskName = "RRKAL AIS Collector"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$taskInfo = $null
if ($task) {
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
}

$ingest = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match "python" -and
  $_.CommandLine -match "core\.py" -and
  $_.CommandLine -match "ingest-ais"
})

[pscustomobject]@{
  task_exists = [bool]$task
  task_state = if ($task) { $task.State.ToString() } else { $null }
  last_run_time = if ($taskInfo) { $taskInfo.LastRunTime } else { $null }
  last_task_result = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }
  ingest_process_count = $ingest.Count
  ingest_pids = @($ingest | ForEach-Object { $_.ProcessId })
  repo = "$repo"
} | ConvertTo-Json -Compress
