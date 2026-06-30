$ErrorActionPreference = "Stop"

$taskName = "RRKAL AIS Collector"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$runner = Join-Path $repo "scripts\run_ais_collector.ps1"

if (-not (Test-Path -LiteralPath $runner)) {
  throw "AIS collector runner not found: $runner"
}

$userPassword = [Environment]::GetEnvironmentVariable("RRKAL_AIS_MYSQL_PASSWORD", "User")
$processPassword = [Environment]::GetEnvironmentVariable("RRKAL_AIS_MYSQL_PASSWORD", "Process")
if ([string]::IsNullOrWhiteSpace($userPassword) -and [string]::IsNullOrWhiteSpace($processPassword)) {
  throw "Set RRKAL_AIS_MYSQL_PASSWORD as a user environment variable before installing the scheduled task."
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`"" `
  -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel LeastPrivilege

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0)

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

Write-Output "installed:$taskName"
