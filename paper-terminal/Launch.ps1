param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskProject = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:8790/'
function Show-Terminal { if (!$NoBrowser) { Start-Process $taskUrl } }
try { $taskExisting = Invoke-RestMethod ($taskUrl + 'api/health') -TimeoutSec 2 } catch { $taskExisting = $null }
if ($taskExisting -and $taskExisting.app -eq 'paper-terminal' -and $taskExisting.mode -eq 'paper') { Show-Terminal; exit 0 }
$taskNodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$taskBundledRuntime = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$taskNodeRuntime = if (Test-Path -LiteralPath $taskBundledRuntime) { $taskBundledRuntime } elseif ($taskNodeCommand) { $taskNodeCommand.Source } else { $taskBundledRuntime }
$taskServer = Join-Path $taskProject 'dist/server/server.js'
if (!(Test-Path -LiteralPath $taskNodeRuntime) -or !(Test-Path -LiteralPath $taskServer)) { throw '未找到已构建的本机运行程序。请保留项目目录和运行环境。' }
$taskNodeMajor = & $taskNodeRuntime -p "Number(process.versions.node.split('.')[0])"
if ([int]$taskNodeMajor -lt 24) { throw '运行环境需要Node 24或更新版本，请使用项目自带的运行环境。' }
$taskLogs = Join-Path $taskProject 'data/launch-logs'
New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Start-Process -FilePath $taskNodeRuntime -ArgumentList @('"' + $taskServer + '"') -WorkingDirectory $taskProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs ($taskStamp + '-out.log')) -RedirectStandardError (Join-Path $taskLogs ($taskStamp + '-error.log')) | Out-Null
for ($taskAttempt=0; $taskAttempt -lt 30; $taskAttempt++) {
  Start-Sleep -Milliseconds 500
  try { $taskHealth = Invoke-RestMethod ($taskUrl + 'api/health') -TimeoutSec 2; if ($taskHealth.app -eq 'paper-terminal' -and $taskHealth.mode -eq 'paper') { Show-Terminal; exit 0 } } catch {}
}
throw '本机服务尚未就绪，详情保存在 data/launch-logs。'
