$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$taskListener = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$taskListener) { Write-Host '模拟服务已停止。'; exit 0 }
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskListener.OwningProcess)"
$taskExpected = Join-Path $taskRoot 'dist/server/server.js'
$taskRegistration = Get-Content -LiteralPath (Join-Path $taskRoot 'data/server-runtime.json') -Raw -Encoding utf8 | ConvertFrom-Json
if ($taskRegistration.pid -ne $taskProcess.ProcessId -or [IO.Path]::GetFullPath($taskRegistration.project) -ne $taskRoot -or $taskProcess.Name -ne 'node.exe' -or !($taskProcess.CommandLine.Contains($taskExpected) -or $taskProcess.CommandLine -match 'dist[/\\]server[/\\]server\.js')) { throw '8790端口由其他程序使用，未停止该程序。' }
Stop-Process -Id $taskProcess.ProcessId
Write-Host '模拟服务已停止；虚拟持仓保留，重启后按当前报价继续处理。'
