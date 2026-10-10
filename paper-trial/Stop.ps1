$ErrorActionPreference='Stop'
try { $taskState=Invoke-RestMethod 'http://127.0.0.1:8793/api/state' -TimeoutSec 3 } catch { Write-Output '独立模拟服务没有运行。'; exit 0 }
if($taskState.app -ne 'paper-trial' -or $taskState.mode -ne 'paper') { throw '端口不是独立模拟服务，未停止。' }
Invoke-RestMethod 'http://127.0.0.1:8793/api/stop' -Method Post -ContentType 'application/json' -Headers @{'x-csrf-token'=$taskState.csrf} -Body '{"stop":true}' -TimeoutSec 5 | Out-Null
Write-Output '独立模拟已停止；原研究终端继续运行。'
