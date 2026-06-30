$ErrorActionPreference = "Stop"
$taskName = "RRKAL AIS Collector"
Start-ScheduledTask -TaskName $taskName
Write-Output "started:$taskName"
