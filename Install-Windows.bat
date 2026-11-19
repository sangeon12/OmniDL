
@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "TOOLS_DIR=%SCRIPT_DIR%OmniDL-Core\tools"

where winget >nul 2>&1

if errorlevel 1 (
    echo Installing WinGet...

    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Install-PackageProvider -Name NuGet -Force -Scope CurrentUser | Out-Null; Install-Module -Name Microsoft.WinGet.Client -Force -Scope CurrentUser -Repository PSGallery; Repair-WinGetPackageManager -Force -Latest"

    if errorlevel 1 goto error
)

where winget >nul 2>&1

if errorlevel 1 (
    echo WinGet is not available.
    goto error
)

echo Updating WinGet...

winget upgrade --id Microsoft.AppInstaller -e --accept-source-agreements --accept-package-agreements

echo Installing or updating yt-dlp...

winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements

if errorlevel 1 goto error

echo Installing or updating FFmpeg...

winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements

if errorlevel 1 goto error

echo Installing or updating N_m3u8DL-RE...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
"& { ^
$ErrorActionPreference = 'Stop'; ^
$tools = $env:TOOLS_DIR; ^
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); ^
if ($arch -eq 'Arm64') { $target = 'win-arm64' } elseif ($arch -eq 'X64') { $target = 'win-x64' } else { throw 'Unsupported Windows architecture' }; ^
New-Item -ItemType Directory -Force -Path $tools | Out-Null; ^
$headers = @{ 'User-Agent' = 'OmniDL-Installer'; 'Accept' = 'application/vnd.github+json' }; ^
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest' -Headers $headers; ^
$asset = $release.assets | Where-Object { $_.name -like ('*_' + $target + '_*.zip') -or $_.name -like ('*' + $target + '.zip') } | Select-Object -First 1; ^
if (-not $asset) { throw 'N_m3u8DL-RE download URL not found' }; ^
$exe = Join-Path $tools 'N_m3u8DL-RE.exe'; ^
$marker = Join-Path $tools '.n_m3u8dl-re-version-windows'; ^
$expected = $release.tag_name + '/' + $target; ^
$current = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { '' }; ^
if ((Test-Path $exe) -and ($current -eq $expected)) { Write-Host 'N_m3u8DL-RE is up to date'; return }; ^
$temp = Join-Path $env:TEMP ('OmniDL-' + [guid]::NewGuid().ToString('N')); ^
try { ^
New-Item -ItemType Directory -Force -Path $temp | Out-Null; ^
$zip = Join-Path $temp 'package.zip'; ^
$extract = Join-Path $temp 'extracted'; ^
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip; ^
Expand-Archive -Path $zip -DestinationPath $extract -Force; ^
$source = Get-ChildItem -Path $extract -Filter 'N_m3u8DL-RE.exe' -Recurse -File | Select-Object -First 1; ^
if (-not $source) { throw 'N_m3u8DL-RE executable not found' }; ^
Copy-Item -LiteralPath $source.FullName -Destination $exe -Force; ^
Set-Content -Path $marker -Value $expected -Encoding ASCII; ^
Write-Host ('N_m3u8DL-RE installed: ' + $expected); ^
} finally { ^
if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }; ^
} ^
}"

if errorlevel 1 goto error

echo Installation completed.
pause
exit /b 0

:error
echo Installation failed.
pause
exit /b 1
