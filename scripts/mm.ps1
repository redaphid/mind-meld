# PowerShell wrapper for scripts/mm, so the same commands work from a native
# Windows shell without remembering to prefix them with bash.
#
#   .\scripts\mm.ps1 status
#   .\scripts\mm.ps1 doctor
#
# Requires Git for Windows (its bash is what actually runs the script).

$ErrorActionPreference = 'Stop'

$mm = Join-Path $PSScriptRoot 'mm'

$bash = (Get-Command bash -ErrorAction SilentlyContinue).Source
if (-not $bash) {
    $fallback = "$env:ProgramFiles\Git\bin\bash.exe"
    if (Test-Path $fallback) {
        $bash = $fallback
    } else {
        Write-Error "bash not found. Install Git for Windows, or run: wsl bash scripts/mm $args"
        exit 1
    }
}

& $bash $mm @args
exit $LASTEXITCODE
