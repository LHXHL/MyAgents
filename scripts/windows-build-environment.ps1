# Shared host environment for Windows setup and build entry points.
# The native resource owner still decides whether a compiler is required.

function Initialize-MsvcBuildEnvironment {
    if (Get-Command cl.exe -ErrorAction SilentlyContinue) { return }

    $vsWhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vsWhere -PathType Leaf)) { return }

    $vsPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1
    if (-not $vsPath) { return }
    $vcvarsall = Join-Path $vsPath 'VC\Auxiliary\Build\vcvarsall.bat'
    if (-not (Test-Path -LiteralPath $vcvarsall -PathType Leaf)) { return }

    Write-Host "  Initialize MSVC x64 environment: $vcvarsall" -ForegroundColor Cyan
    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        & cmd.exe /d /s /c "`"$vcvarsall`" x64 >NUL 2>NUL && set > `"$tempFile`""
        if ($LASTEXITCODE -ne 0) { throw "vcvarsall.bat failed (exit $LASTEXITCODE)" }
        Get-Content -LiteralPath $tempFile | ForEach-Object {
            if ($_ -match '^([^=]+)=(.*)$') {
                [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
            }
        }
    } finally {
        Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
    }

    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) { throw 'vcvarsall.bat did not provide cl.exe' }
    Write-Host '  OK - MSVC x64 environment loaded' -ForegroundColor Green
}

function Use-BundledNodeBuildTools {
    param([Parameter(Mandatory = $true)][string]$ProjectDir)

    $nodeDir = Join-Path $ProjectDir 'src-tauri\resources\nodejs'
    $nodeExe = Join-Path $nodeDir 'node.exe'
    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf) -or
        -not (Test-Path -LiteralPath $npmCmd -PathType Leaf)) {
        throw 'Bundled Node.js/npm is missing; run scripts\download_nodejs.ps1 first'
    }

    $env:Path = "$nodeDir;$env:Path"
    $nodeVersion = & node --version
    $npmVersion = & npm --version
    $runtime = Get-Content -LiteralPath (Join-Path $ProjectDir 'scripts\node-runtime.json') -Raw | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne "v$($runtime.node)" -or $npmVersion -ne $runtime.npm) {
        throw "Build tool version mismatch: Node $nodeVersion / npm $npmVersion; expected $($runtime.node) / $($runtime.npm)"
    }
    Write-Host "  Build tools: Node.js $nodeVersion / npm $npmVersion" -ForegroundColor Green
}
