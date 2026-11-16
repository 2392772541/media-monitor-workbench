$ErrorActionPreference = 'Stop'
$TaskName = 'MediaMonitorWorkbench'
$Root = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $Root 'scripts\start.mjs'
$NodeExe = (Get-Command node).Source

$Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$StartScript`" --no-open" -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description '个人自媒体监控工作台后台定时采集服务' -Force | Out-Null
Write-Host "Registered scheduled task [$TaskName] successfully."
