[CmdletBinding()]
param(
  [string]$InstallerDirectory = "src-tauri/target/release/bundle/nsis",
  [string]$ExpectedVersion = "",
  [string]$ReportPath = "release-preflight-report.json"
)

$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "Windows installer verification must run on Windows"
}

if (-not $ExpectedVersion) {
  $ExpectedVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
}

$installers = @(Get-ChildItem -Path $InstallerDirectory -Filter "*-setup.exe" -File)
if ($installers.Count -ne 1) {
  throw "Expected one NSIS installer in $InstallerDirectory, found $($installers.Count)"
}

$installer = $installers[0]
$registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\yt-dlp-tauri"
$defaultInstallDirectory = Join-Path $env:LOCALAPPDATA "yt-dlp-tauri"
if ((Test-Path $registryPath) -or (Test-Path $defaultInstallDirectory)) {
  throw "Release preflight requires a clean yt-dlp-tauri installation state"
}

$install = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -PassThru -Wait
if ($install.ExitCode -ne 0) {
  throw "NSIS installer exited with code $($install.ExitCode)"
}

$registration = Get-ItemProperty -Path $registryPath
if ($registration.DisplayVersion -ne $ExpectedVersion) {
  throw "Installed version $($registration.DisplayVersion) does not match $ExpectedVersion"
}

$installDirectory = [string]$registration.InstallLocation
$installDirectory = $installDirectory.Trim('"')
if (-not $installDirectory) {
  throw "NSIS registration is missing InstallLocation"
}

$installedExecutable = Join-Path $installDirectory "yt-dlp-tauri.exe"
$installedManifest = Join-Path $installDirectory "tools-manifest.json"
$uninstaller = Join-Path $installDirectory "uninstall.exe"
foreach ($path in @($installedExecutable, $installedManifest, $uninstaller)) {
  if (-not (Test-Path $path -PathType Leaf)) {
    throw "Installed package is missing $path"
  }
}

$productVersion = (Get-Item $installedExecutable).VersionInfo.ProductVersion
if (-not $productVersion.StartsWith($ExpectedVersion, [System.StringComparison]::Ordinal)) {
  throw "Executable product version $productVersion does not match $ExpectedVersion"
}

$app = Start-Process -FilePath $installedExecutable -PassThru
Start-Sleep -Seconds 8
if ($app.HasExited) {
  throw "Installed application exited during the launch probe with code $($app.ExitCode)"
}
Stop-Process -Id $app.Id -Force
$app.WaitForExit()

$installerHash = (Get-FileHash -Path $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$installerSize = $installer.Length
$uninstall = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait
if ($uninstall.ExitCode -ne 0) {
  throw "NSIS uninstaller exited with code $($uninstall.ExitCode)"
}
if ((Test-Path $registryPath) -or (Test-Path $installedExecutable)) {
  throw "NSIS uninstaller did not remove the application registration and executable"
}

$report = [ordered]@{
  schemaVersion = 1
  version = $ExpectedVersion
  installer = [ordered]@{
    name = $installer.Name
    size = $installerSize
    sha256 = $installerHash
  }
  installedManifest = "tools-manifest.json"
  launchProbeSeconds = 8
  uninstalled = $true
}
$report | ConvertTo-Json -Depth 4 | Set-Content -Path $ReportPath -Encoding utf8
$report | ConvertTo-Json -Depth 4
