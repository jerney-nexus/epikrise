param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("x64", "arm64")]
  [string]$Architecture,

  [Parameter(Mandatory = $true)]
  [ValidateSet("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$BuildDirectory,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,

  [string]$PreviousStoreVersion
)

$ErrorActionPreference = "Stop"

$expectedTargets = @{
  x64 = "x86_64-pc-windows-msvc"
  arm64 = "aarch64-pc-windows-msvc"
}
if ($Target -ne $expectedTargets[$Architecture]) {
  throw "Target $Target does not match requested MSIX architecture $Architecture."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$resolvedBuildDirectory = (Resolve-Path -LiteralPath $BuildDirectory).Path
$resolvedOutputDirectory = [System.IO.Path]::GetFullPath(
  (Join-Path $repoRoot $OutputDirectory)
)
$sdkBinDirectory = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$makeAppx = (Get-Command makeappx.exe -ErrorAction SilentlyContinue).Source
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
$runId = [guid]::NewGuid().ToString("N")
$stageDirectory = Join-Path $temporaryRoot "epikrise-msix-stage-$runId"
$unpackDirectory = Join-Path $temporaryRoot "epikrise-msix-unpack-$runId"
$packagePath = $null
$completed = $false

try {
  $stageArguments = @(
    (Join-Path $repoRoot "scripts/store-msix.mjs"),
    "stage",
    "--repo",
    $repoRoot,
    "--architecture",
    $Architecture,
    "--target",
    $Target,
    "--build-directory",
    $resolvedBuildDirectory,
    "--stage-directory",
    $stageDirectory
  )
  if ($PreviousStoreVersion) {
    $stageArguments += @("--previous-store-version", $PreviousStoreVersion)
  }
  $stageResult = & node @stageArguments
  if ($LASTEXITCODE -ne 0) {
    throw "MSIX staging validation failed with exit code $LASTEXITCODE."
  }
  $packageVersion = ($stageResult | ConvertFrom-Json).version
  if (-not $packageVersion) {
    throw "MSIX staging did not return a package version."
  }

  $manifestPath = Join-Path $stageDirectory "AppxManifest.xml"
  $xmlSettings = [System.Xml.XmlReaderSettings]::new()
  $xmlSettings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $xmlSettings.XmlResolver = $null
  $xmlReader = [System.Xml.XmlReader]::Create($manifestPath, $xmlSettings)
  $manifestDocument = [System.Xml.XmlDocument]::new()
  $manifestDocument.XmlResolver = $null
  try {
    $manifestDocument.Load($xmlReader)
  } finally {
    $xmlReader.Dispose()
  }

  $identity = $manifestDocument.SelectSingleNode("//*[local-name()='Identity']")
  if (
    $identity.Name -ne "Identity" -or
    $identity.GetAttribute("Name") -ne "JerneyNexus.Epikrise" -or
    $identity.GetAttribute("Publisher") -ne "CN=902B70F1-3B51-4D25-9253-8C079B1E0AFD" -or
    $identity.GetAttribute("Version") -ne $packageVersion -or
    $identity.GetAttribute("ProcessorArchitecture") -ne $Architecture
  ) {
    throw "MSIX manifest identity, version, or architecture is invalid."
  }
  $application = $manifestDocument.SelectSingleNode("//*[local-name()='Application']")
  if (
    $application.GetAttribute("Executable") -ne "epikrise.exe" -or
    $application.GetAttribute("EntryPoint") -ne "Windows.FullTrustApplication"
  ) {
    throw "MSIX manifest entrypoint must be the Epikrise application, not an installer."
  }
  foreach ($asset in @(
      "//*[local-name()='Properties']/*[local-name()='Logo']",
      "//*[local-name()='VisualElements']/@Square150x150Logo",
      "//*[local-name()='VisualElements']/@Square44x44Logo"
    )) {
    $assetNode = $manifestDocument.SelectSingleNode($asset)
    if (-not $assetNode) {
      throw "MSIX manifest is missing a required logo reference: $asset."
    }
    $assetPath = if ($assetNode -is [System.Xml.XmlAttribute]) {
      $assetNode.Value
    } else {
      $assetNode.InnerText
    }
    if (-not (Test-Path -LiteralPath (Join-Path $stageDirectory $assetPath) -PathType Leaf)) {
      throw "MSIX manifest references a missing logo: $assetPath."
    }
  }
  if (-not $manifestDocument.SelectSingleNode("//*[local-name()='Capability' and @Name='runFullTrust']")) {
    throw "MSIX manifest is missing the runFullTrust capability."
  }

  New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null
  $packagePath = Join-Path $resolvedOutputDirectory "Epikrise_$($packageVersion)_$Architecture.msix"
  if (Test-Path -LiteralPath $packagePath) {
    throw "Refusing to overwrite existing Store package: $packagePath."
  }

  & $makeAppx pack /d $stageDirectory /p $packagePath
  if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx pack failed with exit code $LASTEXITCODE."
  }

  & $makeAppx unpack /p $packagePath /d $unpackDirectory
  if ($LASTEXITCODE -ne 0) {
    throw "MakeAppx unpack validation failed with exit code $LASTEXITCODE."
  }
  & node (Join-Path $repoRoot "scripts/store-msix.mjs") verify `
    --layout $unpackDirectory `
    --architecture $Architecture `
    --target $Target `
    --version $packageVersion
  if ($LASTEXITCODE -ne 0) {
    throw "Unpacked MSIX layout validation failed with exit code $LASTEXITCODE."
  }

  $completed = $true
  Write-Output "Created unsigned Store MSIX: $packagePath"
} finally {
  foreach ($temporaryDirectory in @($stageDirectory, $unpackDirectory)) {
    if (Test-Path -LiteralPath $temporaryDirectory) {
      Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
  }
  if (-not $completed -and $packagePath -and (Test-Path -LiteralPath $packagePath)) {
    Remove-Item -LiteralPath $packagePath -Force
  }
}
