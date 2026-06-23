$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$TauriRoot = Join-Path $Root 'src-tauri'
$ToolsRoot = Join-Path $TauriRoot 'Tools\win-x64'
$TempRoot = Join-Path $TauriRoot 'Tools\.tmp'

New-Item -ItemType Directory -Force -Path $ToolsRoot, $TempRoot | Out-Null

function Get-FileSha256([string] $Path) {
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Assert-Hash([string] $Path, [string] $Expected) {
  $actual = Get-FileSha256 $Path
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Path. Expected $Expected, got $actual."
  }
}

function Download-File([string] $Url, [string] $Destination) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination
}

$ytDlp = Join-Path $ToolsRoot 'yt-dlp\yt-dlp.exe'
Download-File 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp.exe' $ytDlp
Assert-Hash $ytDlp '3a48cb955d55c8821b60ccbdbbc6f61bc958f2f3d3b7ad5eaf3d83a543293a27'

$ffmpegZip = Join-Path $TempRoot 'ffmpeg-N-124634-g69bdb05f36-win64-gpl.zip'
Download-File 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/autobuild-2026-05-25-16-31/ffmpeg-N-124634-g69bdb05f36-win64-gpl.zip' $ffmpegZip
$ffmpegExtract = Join-Path $TempRoot 'ffmpeg'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $ffmpegExtract
Expand-Archive -Force -Path $ffmpegZip -DestinationPath $ffmpegExtract
$ffmpegSourceRoot = Get-ChildItem -Path $ffmpegExtract -Directory | Select-Object -First 1
if (-not $ffmpegSourceRoot) { throw 'Unable to find extracted FFmpeg directory.' }
$ffmpegBin = Join-Path $ToolsRoot 'ffmpeg\bin'
New-Item -ItemType Directory -Force -Path $ffmpegBin | Out-Null
Copy-Item -Force (Join-Path $ffmpegSourceRoot.FullName 'bin\ffmpeg.exe') (Join-Path $ffmpegBin 'ffmpeg.exe')
Copy-Item -Force (Join-Path $ffmpegSourceRoot.FullName 'bin\ffprobe.exe') (Join-Path $ffmpegBin 'ffprobe.exe')
Assert-Hash (Join-Path $ffmpegBin 'ffmpeg.exe') 'af4013cf0cf890bc7a6f91738fa0d391d3870f342fef5c77803bde5b692adaa5'
Assert-Hash (Join-Path $ffmpegBin 'ffprobe.exe') '8c0b8a4d3bbad0b12953b008dd6fd19856fd91abbb0e01aad44735f845b617bd'

$denoZip = Join-Path $TempRoot 'deno-x86_64-pc-windows-msvc.zip'
Download-File 'https://github.com/denoland/deno/releases/download/v2.7.14/deno-x86_64-pc-windows-msvc.zip' $denoZip
$denoExtract = Join-Path $TempRoot 'deno'
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $denoExtract
Expand-Archive -Force -Path $denoZip -DestinationPath $denoExtract
$denoDir = Join-Path $ToolsRoot 'deno'
New-Item -ItemType Directory -Force -Path $denoDir | Out-Null
Copy-Item -Force (Join-Path $denoExtract 'deno.exe') (Join-Path $denoDir 'deno.exe')
Assert-Hash (Join-Path $denoDir 'deno.exe') 'b6e83993f1f1ab97075a77043de61118966d719b5450bc631251d47c3a34230b'

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TempRoot
Write-Host 'Bundled tools restored successfully.'
