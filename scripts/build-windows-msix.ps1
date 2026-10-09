param(
  [Parameter(Mandatory = $true)]
  [string]$Target,
  [Parameter(Mandatory = $true)]
  [string]$ReleaseRoot
)

$ErrorActionPreference = "Stop"

switch ($Target) {
  "x86_64-pc-windows-msvc" { $architecture = "x64" }
  "aarch64-pc-windows-msvc" { $architecture = "arm64" }
  default { throw "Unsupported Windows target: $Target" }
}
$hostTriple = (& rustc -vV | Select-String '^host: ').Line -replace '^host: ', ''
if ($hostTriple -ne $Target) {
  throw "MSIX packaging requires target $Target to match native host $hostTriple."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sourceRoot = Join-Path $repoRoot "src-tauri"
$layoutRoot = Join-Path $ReleaseRoot "msix-layout"
$outputRoot = Join-Path $ReleaseRoot "bundle\msix"
$outputPath = Join-Path $outputRoot "epikrise-$Target.msix"
$packageVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
if ($packageVersion -notmatch '^(\d{4})\.(0[1-9]|1[0-2])\.(0|[1-9]\d*)$') {
  throw "Package version must use padded CalVer."
}
$msixVersion = "$($Matches[1]).$([int]$Matches[2]).$([int]$Matches[3]).0"
foreach ($component in $msixVersion.Split('.')) {
  if ([int]$component -gt 65535) {
    throw "MSIX version component exceeds 65535."
  }
}

if (Test-Path $layoutRoot) {
  Remove-Item $layoutRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $layoutRoot, $outputRoot | Out-Null

$files = @(
  [pscustomobject]@{ Source = Join-Path $ReleaseRoot "epikrise.exe"; Destination = Join-Path $layoutRoot "epikrise.exe" },
  [pscustomobject]@{ Source = Join-Path $sourceRoot "binaries\tesseract-$Target.exe"; Destination = Join-Path $layoutRoot "binaries\tesseract.exe" },
  [pscustomobject]@{ Source = Join-Path $sourceRoot "resources\ocr\pdfium\pdfium.dll"; Destination = Join-Path $layoutRoot "resources\ocr\pdfium\pdfium.dll" },
  [pscustomobject]@{ Source = Join-Path $sourceRoot "resources\ocr\tessdata\deu.traineddata"; Destination = Join-Path $layoutRoot "resources\ocr\tessdata\deu.traineddata" },
  [pscustomobject]@{ Source = Join-Path $sourceRoot "resources\ocr\tessdata\eng.traineddata"; Destination = Join-Path $layoutRoot "resources\ocr\tessdata\eng.traineddata" }
)
foreach ($file in $files) {
  if (-not (Test-Path -LiteralPath $file.Source -PathType Leaf)) {
    throw "Required MSIX input is missing: $($file.Source)"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $file.Destination) | Out-Null
  Copy-Item -LiteralPath $file.Source -Destination $file.Destination
}

$assetsRoot = Join-Path $layoutRoot "Assets"
New-Item -ItemType Directory -Force -Path $assetsRoot | Out-Null
foreach ($asset in @("Square150x150Logo.png", "Square44x44Logo.png", "StoreLogo.png")) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot "icons\$asset") -Destination (Join-Path $assetsRoot $asset)
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
  <Identity Name="Epikrise.Diagnostic" Publisher="CN=Epikrise Diagnostic" Version="$msixVersion" ProcessorArchitecture="$architecture" />
  <Properties>
    <DisplayName>Epikrise</DisplayName>
    <PublisherDisplayName>Epikrise</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-US" />
    <Resource Language="de-DE" />
  </Resources>
  <Applications>
    <Application Id="Epikrise" Executable="epikrise.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Epikrise" Description="Local clinical drafting assistant" BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@
Set-Content -LiteralPath (Join-Path $layoutRoot "AppxManifest.xml") -Value $manifest -Encoding utf8

$sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
$makeAppx = Get-ChildItem -Path $sdkRoot -Filter MakeAppx.exe -Recurse -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1
if (-not $makeAppx) {
  throw "MakeAppx.exe was not found in the Windows 10 SDK."
}
& $makeAppx.FullName pack /d $layoutRoot /p $outputPath /o
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "MakeAppx failed to create the MSIX package."
}
Write-Output "Built unsigned diagnostic MSIX: $outputPath"