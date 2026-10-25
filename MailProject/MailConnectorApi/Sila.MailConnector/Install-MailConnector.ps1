# Install-MailConnector.ps1 -- one-time IIS setup of the Mail Connector API on
# silamail.glcpaints.com (10.1.245.2). Run in an elevated PowerShell from the
# site folder (where Sila.MailConnector.dll is). Safe to run again.
#
#   .\Install-MailConnector.ps1 -CertThumbprint <thumbprint>
#
# What it does:
#   1. checks the .NET Hosting Bundle (AspNetCoreModuleV2) and Application Initialization
#   2. app pool "SilaMailConnector": No Managed Code, AlwaysRunning, no idle
#      timeout, no periodic recycle -- the API's background workers (Exchange
#      sync, Mail Monitor push) must never be stopped by IIS
#   3. site "SilaMailConnector" on https port 9000, preload on, the certificate bound
#   4. appsettings.Exchange.local.json (the secrets): Administrators, SYSTEM and
#      the pool only
# It does NOT open port 9000 in Windows Firewall: nothing needs to call in
# (Access:AllowedNetworks is localhost only; the Mail Monitor is pushed out).
param(
    [Parameter(Mandatory = $true)][string]$CertThumbprint,
    [int]$Port = 9000,
    [string]$SiteName = 'SilaMailConnector'
)
$ErrorActionPreference = 'Stop'
Import-Module WebAdministration
$path = $PSScriptRoot
$pool = $SiteName

# 1. prerequisites
if (-not (Get-WebGlobalModule -Name AspNetCoreModuleV2 -ErrorAction SilentlyContinue)) {
    throw 'The .NET 10 Hosting Bundle is not installed (AspNetCoreModuleV2 missing). Install it, then run this again.'
}
if (-not (Get-WebGlobalModule -Name ApplicationInitializationModule -ErrorAction SilentlyContinue)) {
    Write-Warning 'IIS Application Initialization is not installed (Install-WindowsFeature Web-AppInit). Without it the API only starts on its first request after a server restart.'
}
$thumb = $CertThumbprint -replace '\s', ''
$cert = Get-Item "Cert:\LocalMachine\My\$thumb" -ErrorAction SilentlyContinue
if (-not $cert) { throw "No certificate $thumb in LocalMachine\My." }
if (-not (Test-Path (Join-Path $path 'Sila.MailConnector.dll'))) { throw "Run this from the site folder (Sila.MailConnector.dll not found in $path)." }

# 2. application pool -- always running
if (-not (Test-Path "IIS:\AppPools\$pool")) { New-WebAppPool -Name $pool | Out-Null }
Set-ItemProperty "IIS:\AppPools\$pool" -Name managedRuntimeVersion -Value ''
Set-ItemProperty "IIS:\AppPools\$pool" -Name startMode -Value 'AlwaysRunning'
Set-ItemProperty "IIS:\AppPools\$pool" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
Set-ItemProperty "IIS:\AppPools\$pool" -Name recycling.periodicRestart.time -Value ([TimeSpan]::Zero)

# 3. site on https :9000, preloaded, certificate bound
if (-not (Test-Path "IIS:\Sites\$SiteName")) {
    New-Website -Name $SiteName -PhysicalPath $path -ApplicationPool $pool -Port $Port -Ssl | Out-Null
} else {
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $path
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationPool -Value $pool
}
Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationDefaults.preloadEnabled -Value $true
$ssl = "IIS:\SslBindings\0.0.0.0!$Port"
if (Test-Path $ssl) { Remove-Item $ssl }
$cert | New-Item $ssl | Out-Null

# 4. the secrets file: readable by the pool only
$secrets = Join-Path $path 'appsettings.Exchange.local.json'
if (Test-Path $secrets) {
    & icacls.exe $secrets /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' "IIS AppPool\${pool}:R" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not set permissions on appsettings.Exchange.local.json.' }
} else {
    Write-Warning 'appsettings.Exchange.local.json is missing: create it (step 4 of DEPLOY.md), then run this again.'
}

Start-WebAppPool -Name $pool -ErrorAction SilentlyContinue
Start-Website -Name $SiteName -ErrorAction SilentlyContinue
Write-Host "Done. Check on this server: https://localhost:$Port/health (certificate name warning is expected for 'localhost')."
