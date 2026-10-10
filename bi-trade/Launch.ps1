param([switch]$NoBrowser)
$ErrorActionPreference='Stop'
$taskProject=$PSScriptRoot
try {$taskHealth=Invoke-RestMethod 'http://127.0.0.1:8794/api/health' -TimeoutSec 2} catch {$taskHealth=$null}
if($taskHealth -and $taskHealth.app -eq 'bi-trade'){if(!$NoBrowser){Start-Process 'http://127.0.0.1:8794/'};exit 0}
try {$taskSource=Invoke-RestMethod 'http://127.0.0.1:8790/api/health' -TimeoutSec 2} catch {$taskSource=$null}
if(!$taskSource -or $taskSource.app -ne 'paper-terminal'){
 $taskPowerShell=(Get-Process -Id $PID).Path
 $taskSourceScript=Join-Path $taskProject '..\paper-terminal\Launch.ps1'
 $taskStart=Start-Process -FilePath $taskPowerShell -ArgumentList @('-NoProfile','-NonInteractive','-File','"'+$taskSourceScript+'"','-NoBrowser') -WindowStyle Hidden -Wait -PassThru
 if($taskStart.ExitCode -ne 0){throw '行情来源未启动，请查看paper-terminal日志。'}
}
$taskNode=(Get-Command node.exe -ErrorAction Stop).Source
. (Join-Path $taskProject 'Use-LocalNetwork.ps1')
$taskNodeOptions=@()
if(Enable-BiTradeLocalProxy){$taskNodeOptions+='--use-env-proxy'}
$taskLogs=Join-Path $taskProject 'data\logs'
New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
$taskStamp=Get-Date -Format 'yyyyMMdd-HHmmss'
Start-Process -FilePath $taskNode -ArgumentList ($taskNodeOptions+@('"'+(Join-Path $taskProject 'server.mjs')+'"')) -WorkingDirectory $taskProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs ($taskStamp+'-out.log')) -RedirectStandardError (Join-Path $taskLogs ($taskStamp+'-error.log')) | Out-Null
for($taskAttempt=0;$taskAttempt -lt 20;$taskAttempt++){Start-Sleep -Milliseconds 500;try {$taskHealth=Invoke-RestMethod 'http://127.0.0.1:8794/api/health' -TimeoutSec 2;if($taskHealth.app -eq 'bi-trade'){if(!$NoBrowser){Start-Process 'http://127.0.0.1:8794/'};exit 0}}catch{}}
throw 'bi trade 尚未就绪，请检查bi-trade/data/logs。'
