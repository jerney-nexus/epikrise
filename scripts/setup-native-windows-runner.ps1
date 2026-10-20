$ErrorActionPreference = "Stop"

$nsisVersion = "3.12"
$restartManagerUrl = "https://raw.githubusercontent.com/NSIS-Dev/NSIS/v312/Include/Win/RestartManager.nsh"
$expectedSha256 = "67149978412da9b283e2e1abe48a360093df9caf6363373e2cabe463978b7c0e"
$tessdataCommit = "65727574dfcd264acbb0c3e07860e4e9e9b22185"
$tessdataFiles = @(
  @{
    Name = "deu"
    Sha256 = "19d219bbb6672c869d20a9636c6816a81eb9a71796cb93ebe0cb1530e2cdb22d"
  },
  @{
    Name = "eng"
    Sha256 = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"
  }
)

choco install nsis --version=$nsisVersion --yes --no-progress

$programFilesX86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
$nsisDirectory = Join-Path $programFilesX86 "NSIS"
$makensis = Join-Path $nsisDirectory "makensis.exe"
if (-not (Test-Path -LiteralPath $makensis)) {
  throw "NSIS $nsisVersion was not found at $makensis."
}

$temporaryFile = Join-Path $env:RUNNER_TEMP "RestartManager.nsh"
Invoke-WebRequest -Uri $restartManagerUrl -OutFile $temporaryFile
$actualSha256 = (Get-FileHash -LiteralPath $temporaryFile -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) {
  throw "RestartManager.nsh SHA-256 mismatch: expected $expectedSha256, found $actualSha256."
}

$includeDirectory = Join-Path $nsisDirectory "Include\Win"
New-Item -ItemType Directory -Path $includeDirectory -Force | Out-Null
Copy-Item -LiteralPath $temporaryFile -Destination (Join-Path $includeDirectory "RestartManager.nsh") -Force
Remove-Item -LiteralPath $temporaryFile -Force

$tessdataDirectory = Join-Path $env:RUNNER_TEMP "epikrise-tessdata"
New-Item -ItemType Directory -Path $tessdataDirectory -Force | Out-Null
foreach ($file in $tessdataFiles) {
  $dataPath = Join-Path $tessdataDirectory "$($file.Name).traineddata"
  $dataUrl = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/$tessdataCommit/$($file.Name).traineddata"
  Invoke-WebRequest -Uri $dataUrl -OutFile $dataPath
  $actualSha256 = (Get-FileHash -LiteralPath $dataPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $file.Sha256) {
    throw "$($file.Name).traineddata SHA-256 mismatch: expected $($file.Sha256), found $actualSha256."
  }
}

"EPIKRISE_TESSDATA_DIR=$tessdataDirectory" >> $env:GITHUB_ENV
