$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath($PSScriptRoot)
$taskListener=Get-NetTCPConnection -LocalPort 8794 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if(!$taskListener){Write-Host 'bi trade 已停止。';exit 0}
$taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $($taskListener.OwningProcess)"
$taskRegistration=Get-Content -LiteralPath (Join-Path $taskRoot 'data/runtime.json') -Raw -Encoding utf8 | ConvertFrom-Json
$taskExpected=Join-Path $taskRoot 'server.mjs'
if($taskRegistration.app -ne 'bi-trade' -or $taskRegistration.pid -ne $taskProcess.ProcessId -or [IO.Path]::GetFullPath($taskRegistration.project) -ne $taskRoot -or $taskProcess.Name -ne 'node.exe' -or !$taskProcess.CommandLine.Contains($taskExpected)){throw '8794端口由其他程序使用，未停止该程序。'}
Stop-Process -Id $taskProcess.ProcessId
Write-Host 'bi trade 已停止；独立模拟账本保留，重启后核对账本并重新观察行情。'
