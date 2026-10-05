param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskScript = Join-Path $PSScriptRoot 'service.js'
$taskHostScript = Join-Path $PSScriptRoot 'task-host.ps1'
$taskShell = Join-Path $PSHOME 'powershell.exe'
$taskName = 'AccountRegionLab-Local'
$taskIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Remove) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask -and $existingTask.Actions.Arguments -notlike ('*"' + $taskHostScript + '"*') -and $existingTask.Actions.Arguments -ne ('"' + $taskScript + '"')) {
        throw 'The task with this name belongs to another project location. It was not removed.'
    }
    if ($existingTask) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    Write-Output 'Login startup removed. Stop.cmd can stop the current service.'
    exit 0
}
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskHostScript + '" -NodePath "' + $taskNode + '"'
$taskAction = New-ScheduledTaskAction -Execute $taskShell -Argument $taskArguments -WorkingDirectory $taskRoot
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $taskIdentity
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskIdentity -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$taskDefinition = New-ScheduledTask -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Run the local Account Region Lab dashboard when this user logs on. Uses the project launcher.local.json data directory. No administrator rights.'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.Actions.Arguments -ne $taskAction.Arguments -and $existingTask.Actions.Arguments -ne ('"' + $taskScript + '"')) {
    throw 'A different task already uses this name. It was not overwritten.'
}
Register-ScheduledTask -TaskName $taskName -InputObject $taskDefinition -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output ('Login startup installed for ' + $taskIdentity + '. Remove with Disable-Login-Startup.cmd.')
