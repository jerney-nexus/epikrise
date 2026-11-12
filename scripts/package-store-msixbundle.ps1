param(
  [Parameter(Mandatory = $true)]
  [string]$X64Package,

  [Parameter(Mandatory = $true)]
  [string]$Arm64Package,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"

$packagePattern = '^Epikrise_(?<version>\d+\.\d+\.\d+\.\d+)_(?<architecture>x64|arm64)\.msix$'
$packages = @(
  @{ Path = $X64Package; Architecture = "x64" },
  @{ Path = $Arm64Package; Architecture = "arm64" }
)
$versions = @()
foreach ($package in $packages) {
  $resolved = (Resolve-Path -LiteralPath $package.Path).Path
  $name = Split-Path -Leaf $resolved
  if ($name -notmatch $packagePattern -or $Matches.architecture -ne $package.Architecture) {
    throw "Store package $name does not match architecture $($package.Architecture)."
  }
  $versions += $Matches.version
  $package.Path = $resolved
}
if (($versions | Select-Object -Unique).Count -ne 1) {
  throw "Store packages must share one version: $($versions -join ', ')."
}
$bundleVersion = $versions[0]

$makeAppx = (Get-Command makeappx.exe -ErrorAction SilentlyContinue).Source
$sdkBinDirectory = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
if (-not $makeAppx -and (Test-Path -LiteralPath $sdkBinDirectory)) {
  $preferredToolArchitecture = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    "arm64"
  } else {
    "x64"
  }
  foreach ($toolArchitecture in @($preferredToolArchitecture, "x64", "arm64", "x86") |
      Select-Object -Unique) {
    $makeAppx = Get-ChildItem -LiteralPath $sdkBinDirectory -Directory |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "$toolArchitecture\makeappx.exe" } |
      Where-Object { Test-Path -LiteralPath $_ } |
      Select-Object -First 1
    if ($makeAppx) {
      break
    }
  }
}
if (-not $makeAppx) {
  throw "Windows SDK MakeAppx was not found. Install the Windows 10/11 SDK; this script does not install tools."
}

$temporaryRoot = if ($env:RUNNER_TEMP) {
  $env:RUNNER_TEMP
} else {
  [System.IO.Path]::GetTempPath()
}
$workRoot = Join-Path $temporaryRoot ("epikrise-store-bundle-" + [guid]::NewGuid().ToString("N"))
$inputDirectory = Join-Path $workRoot "packages"
$unbundleDirectory = Join-Path $workRoot "unbundled"
New-Item -ItemType Directory -Path $inputDirectory, $unbundleDirectory | Out-Null

try {
  foreach ($package in $packages) {
    Copy-Item -LiteralPath $package.Path -Destination $inputDirectory
  }

  $bundleName = "Epikrise_$($bundleVersion)_bundle.msixbundle"
  $outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
  $bundlePath = Join-Path $outputRoot $bundleName
  if (Test-Path -LiteralPath $bundlePath) {
    throw "Store bundle already exists: $bundlePath."
  }

  & $makeAppx bundle /d $inputDirectory /p $bundlePath /bv $bundleVersion /o
  if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx bundle failed with exit code $LASTEXITCODE."
  }

  & $makeAppx unbundle /p $bundlePath /d $unbundleDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx unbundle validation failed with exit code $LASTEXITCODE."
  }

  $manifestPath = Join-Path $unbundleDirectory "AppxMetadata\AppxBundleManifest.xml"
  [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
  $identity = $manifest.Bundle.Identity
  if ($identity.Version -ne $bundleVersion -or $identity.Name -ne "JerneyNexus.Epikrise") {
    throw "Store bundle identity does not match Epikrise $bundleVersion."
  }
  $architectures = @(
    $manifest.Bundle.Packages.Package |
      Where-Object { $_.Type -eq "application" } |
      ForEach-Object { $_.Architecture } |
      Sort-Object -Unique
  )
  if (($architectures -join ",") -ne "arm64,x64") {
    throw "Store bundle must contain x64 and arm64 application packages: $($architectures -join ', ')."
  }

  Write-Output (ConvertTo-Json -Compress @{
    version = $bundleVersion
    file = $bundleName
    architectures = $architectures
  })
} finally {
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}
