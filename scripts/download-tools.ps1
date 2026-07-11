$ErrorActionPreference = 'Stop'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$TauriRoot = Join-Path $Root 'src-tauri'
$ManifestPath = Join-Path $TauriRoot 'tools-manifest.json'
$ToolsRoot = Join-Path $TauriRoot 'Tools\win-x64'
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("yt-dlp-tauri-tools-$([Guid]::NewGuid())")

function Get-FileSha256([string] $Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-Hash([string] $Path, [string] $Expected) {
  if ($Expected -notmatch '^[a-fA-F0-9]{64}$') {
    throw "Invalid SHA-256 in tools-manifest.json for $Path"
  }
  $actual = Get-FileSha256 $Path
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Path. Expected $Expected, got $actual"
  }
}

function Assert-DownloadUrl([string] $Url) {
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref] $uri)) {
    throw "Invalid sourceUrl in tools-manifest.json: $Url"
  }
  if ($uri.Scheme -ne 'https') {
    throw "Tool downloads require HTTPS: $Url"
  }
}

function Download-File([string] $Url, [string] $Destination) {
  Assert-DownloadUrl $Url
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Host "Downloading $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Resolve-ToolDestination([string] $RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath)) {
    throw 'Tool path is missing from tools-manifest.json'
  }
  $normalized = $RelativePath.Replace([char] '/', [IO.Path]::DirectorySeparatorChar)
  $destination = [IO.Path]::GetFullPath((Join-Path $TauriRoot $normalized))
  $toolsPrefix = [IO.Path]::GetFullPath($ToolsRoot).TrimEnd('\') + '\'
  if (-not $destination.StartsWith($toolsPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Tool path escapes the win-x64 root: $RelativePath"
  }
  return $destination
}

function Find-ArchiveMember([string] $ExtractRoot, [string] $Suffix) {
  if ([string]::IsNullOrWhiteSpace($Suffix)) {
    throw 'ZIP tool is missing archivePathSuffix in tools-manifest.json'
  }
  $normalized = $Suffix.Replace([char] '/', [IO.Path]::DirectorySeparatorChar)
  if ([IO.Path]::IsPathRooted($normalized) -or ($normalized.Split('\') -contains '..')) {
    throw "Unsafe archivePathSuffix in tools-manifest.json: $Suffix"
  }
  $needle = '\' + $normalized.TrimStart('\')
  $matches = @(
    Get-ChildItem -LiteralPath $ExtractRoot -Recurse -File |
      Where-Object { $_.FullName.EndsWith($needle, [StringComparison]::OrdinalIgnoreCase) }
  )
  if ($matches.Count -eq 0) {
    throw "No ZIP member matches archivePathSuffix: $Suffix"
  }
  if ($matches.Count -gt 1) {
    throw "Multiple ZIP members match archivePathSuffix: $Suffix"
  }
  return $matches[0].FullName
}

$manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
$targets = @($manifest.targets | Where-Object { $_.target -eq 'win-x64' })
if ($targets.Count -ne 1) {
  throw 'tools-manifest.json must contain exactly one win-x64 target'
}
$target = $targets[0]
$tools = @($target.tools)
foreach ($requiredTool in @('yt-dlp', 'ffmpeg', 'ffprobe', 'deno')) {
  $matches = @($tools | Where-Object { $_.name -eq $requiredTool })
  if ($matches.Count -ne 1) {
    throw "tools-manifest.json must contain exactly one $requiredTool entry for win-x64"
  }
}
$unsupported = @($tools | Where-Object { $_.kind -notin @('file', 'zip') })
if ($unsupported.Count -gt 0) {
  throw "Unsupported tool kind in tools-manifest.json: $($unsupported[0].kind)"
}

New-Item -ItemType Directory -Force -Path $ToolsRoot, $TempRoot | Out-Null

try {
  foreach ($tool in @($tools | Where-Object { $_.kind -eq 'file' })) {
    $destination = Resolve-ToolDestination $tool.path
    Download-File $tool.sourceUrl $destination
    Assert-Hash $destination $tool.sha256
  }

  $zipGroups = @(
    $tools |
      Where-Object { $_.kind -eq 'zip' } |
      Group-Object -Property sourceUrl
  )
  $groupIndex = 0
  foreach ($group in $zipGroups) {
    $groupRoot = Join-Path $TempRoot "archive-$groupIndex"
    $archivePath = Join-Path $groupRoot 'asset.zip'
    $extractRoot = Join-Path $groupRoot 'extracted'
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Download-File $group.Name $archivePath
    Expand-Archive -Force -LiteralPath $archivePath -DestinationPath $extractRoot

    foreach ($tool in $group.Group) {
      $source = Find-ArchiveMember $extractRoot $tool.archivePathSuffix
      $destination = Resolve-ToolDestination $tool.path
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -Force -LiteralPath $source -Destination $destination
      Assert-Hash $destination $tool.sha256
    }
    $groupIndex += 1
  }
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TempRoot
}

Write-Host 'Bundled tools restored successfully'
