$TaskName = 'MediaMonitorWorkbench'
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "已卸载 Windows 计划任务「$TaskName」。"
