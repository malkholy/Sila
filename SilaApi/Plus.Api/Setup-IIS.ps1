param([Parameter(Mandatory=$true)][string]$AppPoolName)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$keyFolder = Join-Path $PSScriptRoot 'App_Data'
New-Item -ItemType Directory -Path $keyFolder -Force | Out-Null
# Administrators + SYSTEM retain full control; the application pool only reads keys.
& icacls.exe $keyFolder /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "IIS AppPool\${AppPoolName}:(OI)(CI)RX"
if ($LASTEXITCODE -ne 0) { throw 'Could not set signing-key directory permissions.' }
if (-not (Test-Path (Join-Path $keyFolder 'auth-signing-key.pem'))) {
    & dotnet .\Plus.Api.dll --initialize-auth
    if ($LASTEXITCODE -ne 0) { throw 'Signing-key initialization failed.' }
} else {
    Write-Host 'Existing signing key preserved.'
}
Write-Host 'Key ready. Run the SQL/ scripts in SSMS (see IIS-DEPLOYMENT.md), configure SQL credentials, then recycle the API pool.'
Write-Host 'Keep App_Data on future updates and back it up securely. Never copy it into a shared publish archive.'
