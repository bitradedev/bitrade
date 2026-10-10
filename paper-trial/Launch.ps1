param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$taskProject=$PSScriptRoot
try { $taskHealth=Invoke-RestMethod 'http://127.0.0.1:8793/api/health' -TimeoutSec 2 } catch { $taskHealth=$null }
if($taskHealth -and $taskHealth.app -eq 'paper-trial' -and $taskHealth.mode -eq 'paper') { if(!$NoBrowser){Start-Process 'http://127.0.0.1:8793/'}; exit 0 }
try { $taskSourceHealth=Invoke-RestMethod 'http://127.0.0.1:8790/api/health' -TimeoutSec 2 } catch { $taskSourceHealth=$null }
if(!$taskSourceHealth -or $taskSourceHealth.app -ne 'paper-terminal' -or $taskSourceHealth.mode -ne 'paper') {
 $taskSourceLaunch=Join-Path $taskProject '..\paper-terminal\Launch.ps1'
 $taskPowerShell=(Get-Process -Id $PID).Path
 $taskSourceProcess=Start-Process -FilePath $taskPowerShell -ArgumentList @('-NoProfile','-NonInteractive','-File','"'+$taskSourceLaunch+'"','-NoBrowser') -WindowStyle Hidden -Wait -PassThru
 if($taskSourceProcess.ExitCode -ne 0){throw '原模拟行情服务未启动，请检查paper-terminal/data/launch-logs。'}
}
$taskNode=(Get-Command node.exe -ErrorAction Stop).Source
$taskLogs=Join-Path $taskProject 'data\logs'
New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
$taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss'
Start-Process -FilePath $taskNode -ArgumentList @('"'+(Join-Path $taskProject 'runner.mjs')+'"') -WorkingDirectory $taskProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs ($taskStamp+'-out.log')) -RedirectStandardError (Join-Path $taskLogs ($taskStamp+'-error.log')) | Out-Null
for($taskAttempt=0;$taskAttempt -lt 20;$taskAttempt++) { Start-Sleep -Milliseconds 500; try { $taskHealth=Invoke-RestMethod 'http://127.0.0.1:8793/api/health' -TimeoutSec 2; if($taskHealth.app -eq 'paper-trial') { if(!$NoBrowser){Start-Process 'http://127.0.0.1:8793/'}; exit 0 } } catch {} }
throw '独立模拟服务尚未就绪，请查看data/logs。'
