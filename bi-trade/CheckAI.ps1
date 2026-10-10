param([switch]$Decision)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Use-LocalNetwork.ps1')
$taskHasLocalProxy=Enable-BiTradeLocalProxy
$taskNodeOptions=@()
if($taskHasLocalProxy){$taskNodeOptions+='--use-env-proxy'}
$taskCheckOptions=@()
if($Decision){$taskCheckOptions+='--decision'}
& node @taskNodeOptions (Join-Path $PSScriptRoot 'scripts/check-ai.mjs') @taskCheckOptions
exit $LASTEXITCODE
