$ErrorActionPreference = "Stop"

$Repository = if ($env:OPENMETAL_REPOSITORY) { $env:OPENMETAL_REPOSITORY } else { "homanp/metal" }
$InstallDir = if ($env:OPENMETAL_INSTALL_DIR) {
  $env:OPENMETAL_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "OpenMetal\bin"
}
$Version = if ($env:OPENMETAL_VERSION) { $env:OPENMETAL_VERSION } else { "latest" }
$Architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
  "ARM64" { "arm64" }
  "AMD64" { "x64" }
  default { throw "openmetal: unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$Asset = "openmetal-windows-$Architecture.zip"
if ($env:OPENMETAL_RELEASE_BASE_URL) {
  $BaseUrl = $env:OPENMETAL_RELEASE_BASE_URL.TrimEnd("/")
} elseif ($Version -eq "latest") {
  $BaseUrl = "https://github.com/$Repository/releases/latest/download"
} else {
  $Tag = if ($Version.StartsWith("cli-v")) { $Version } else { "cli-v$Version" }
  $BaseUrl = "https://github.com/$Repository/releases/download/$Tag"
}

$Temporary = Join-Path ([System.IO.Path]::GetTempPath()) "openmetal-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $Temporary | Out-Null

try {
  Write-Host "Downloading $Asset..."
  $Archive = Join-Path $Temporary $Asset
  $Checksums = Join-Path $Temporary "SHA256SUMS"
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/$Asset" -OutFile $Archive
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/SHA256SUMS" -OutFile $Checksums

  $ChecksumLine = Get-Content $Checksums | Where-Object { $_ -match "\s+$([regex]::Escape($Asset))$" }
  if (-not $ChecksumLine) { throw "openmetal: checksum for $Asset was not found" }
  $Expected = ($ChecksumLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw "openmetal: checksum verification failed" }

  Expand-Archive -Path $Archive -DestinationPath $Temporary -Force
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Copy-Item (Join-Path $Temporary "openmetal.exe") (Join-Path $InstallDir "openmetal.exe") -Force
  Write-Host "Installed openmetal to $(Join-Path $InstallDir 'openmetal.exe')"
  if (-not (($env:PATH -split ";") -contains $InstallDir)) {
    Write-Host "Add $InstallDir to PATH to run openmetal."
  }
} finally {
  Remove-Item -Recurse -Force $Temporary -ErrorAction SilentlyContinue
}
