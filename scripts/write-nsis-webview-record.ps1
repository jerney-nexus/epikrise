#Requires -Version 7
param(
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [Parameter(Mandatory = $true)][string]$VariantDirectory,
  [Parameter(Mandatory = $true)][ValidateSet("embedBootstrapper", "offlineInstaller")][string]$WebViewMode
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Path $VariantDirectory -Force | Out-Null
$packages = @(Get-ChildItem -LiteralPath $BundleRoot -File | Where-Object { $_.Name -match '\.(exe|msi)(\.sig)?$' })
if ($packages.Count -ne 2) {
  throw "Expected one signed package and signature in $BundleRoot, found $($packages.Count)."
}
Copy-Item -LiteralPath $packages.FullName -Destination $VariantDirectory
$package = $packages | Where-Object { $_.Name -like '*.exe' }
$packageHash = (Get-FileHash -LiteralPath (Join-Path $VariantDirectory $package.Name) -Algorithm SHA256).Hash.ToLowerInvariant()
$record = [ordered]@{
  schema_version = 1
  webview_mode = $WebViewMode
  package = $package.Name
  package_sha256 = $packageHash
}
[System.IO.File]::WriteAllText(
  (Join-Path $VariantDirectory "webview-mode.json"),
  (($record | ConvertTo-Json) + "`n"),
  [System.Text.UTF8Encoding]::new($false)
)
