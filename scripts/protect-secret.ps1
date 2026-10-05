param([Parameter(Mandatory = $true)][ValidateSet('Seal', 'Open')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $encoded = [Console]::In.ReadToEnd().Trim()
    $bytes = [Convert]::FromBase64String($encoded)
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    if ($Mode -eq 'Seal') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
    } else {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
    [Console]::Error.Write('Local credential protection failed.')
    exit 1
}
