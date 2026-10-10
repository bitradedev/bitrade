param([int]$IntervalMinutes=60,[int]$DailyCalls=12,[string]$Model='gpt-5.4-mini',[string]$BaseUrl='https://api.openai.com/v1',[switch]$UnlimitedCalls)
$ErrorActionPreference = 'Stop'
$taskModel = $Model
$taskSecret = Read-Host 'OpenAI API key (hidden input)' -AsSecureString
$taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
try {
    $taskValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    $taskDailyLimit = if ($UnlimitedCalls) { $null } else { $DailyCalls }
    $taskPayload = @{ apiKey = $taskValue; model = $taskModel; baseUrl = $BaseUrl; intervalMinutes = $IntervalMinutes; dailyCalls = $taskDailyLimit } | ConvertTo-Json -Compress
    $taskPayload | & node (Join-Path $PSScriptRoot 'ConfigureAI.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'OpenAI configuration failed.' }
    Write-Host 'Saved encrypted configuration. The three showcase Agents will use it automatically; live money stays disabled.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer)
    $taskValue = $null; $taskPayload = $null; $taskSecret = $null
}
