# Reuse the user's existing local Windows proxy only in this process and its children.
# This never changes Windows network settings or disables TLS verification.
function Enable-BiTradeLocalProxy {
    $taskProxyPreferences = Get-ItemProperty -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Internet Settings' -ErrorAction SilentlyContinue
    if (!$taskProxyPreferences.ProxyEnable) { return $false }
    $taskProxyMatch = [regex]::Match([string]$taskProxyPreferences.ProxyServer, '(?:^|;)(?:https?=)?((?:127\.0\.0\.1|localhost):(\d{1,5}))(?:;|$)')
    if (!$taskProxyMatch.Success) { return $false }
    $taskProxyPort = [int]$taskProxyMatch.Groups[2].Value
    if ($taskProxyPort -lt 1 -or $taskProxyPort -gt 65535) { return $false }
    $env:HTTPS_PROXY = 'http://' + $taskProxyMatch.Groups[1].Value
    $env:HTTP_PROXY = $env:HTTPS_PROXY
    $env:NO_PROXY = '127.0.0.1,localhost,::1'
    return $true
}
