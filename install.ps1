#Requires -Version 5.1
<#
  Install (or remove) the dsh-usb-sync plugin in the DSH desktop profile.

  It copies this folder into the profile's node_modules and appends one marked
  block to cordis.patch.yml. Existing entries are never edited; the patch file
  is backed up first.

  Usage:
    install.ps1                  install into %USERPROFILE%\.dsh\profiles\desktop
    install.ps1 -Profile <dir>   use another profile folder (for testing)
    install.ps1 -Uninstall       remove the block and the copied folder
#>
param([switch]$Uninstall, [string]$Profile = '')
$ErrorActionPreference = 'Stop'

$source = $PSScriptRoot
$profileDir = if ($Profile) { $Profile } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile folder not found: $profileDir" }
$target = Join-Path $profileDir 'node_modules\dsh-usb-sync'
$patch = Join-Path $profileDir 'cordis.patch.yml'
$startMarker = '# >>> dsh-usb-sync >>>'
$endMarker = '# <<< dsh-usb-sync <<<'

function Read-Text([string]$file) {
    if (-not (Test-Path -LiteralPath $file)) { return '' }
    return [IO.File]::ReadAllText($file)
}
function Write-Text([string]$file, [string]$text) {
    [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding($false)))
}

if ($Uninstall) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    $text = Read-Text $patch
    if ($text -and $text.Contains($startMarker)) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item -LiteralPath $patch -Destination ($patch + '.bak-' + $stamp) -Force
        $pattern = '(?s)' + [regex]::Escape($startMarker) + '.*?' + [regex]::Escape($endMarker) + '\r?\n?'
        $text = [regex]::Replace($text, $pattern, '')
        Write-Text $patch $text
        Write-Host 'usb-sync entry removed from cordis.patch.yml'
    }
    Write-Host 'Uninstall finished. Restart DSH.'
    exit 0
}

# --- copy the plugin ---------------------------------------------------------
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -Path (Join-Path $source '*') -Destination $target -Recurse -Force
$testDir = Join-Path $target 'test'
if (Test-Path -LiteralPath $testDir) { Remove-Item -LiteralPath $testDir -Recurse -Force }
Write-Host "plugin copied to $target"

# --- append the patch entry --------------------------------------------------
$text = Read-Text $patch
if ($text.Contains($startMarker)) {
    Write-Host 'cordis.patch.yml already has the usb-sync entry - left as is'
    Write-Host 'Install finished. Restart DSH.'
    exit 0
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path -LiteralPath $patch) { Copy-Item -LiteralPath $patch -Destination ($patch + '.bak-' + $stamp) -Force }
$block = @(
    '',
    $startMarker,
    '- id: usb-sync',
    '  name: dsh-usb-sync',
    '  config:',
    '    enabled: true',
    $endMarker
) -join "`r`n"
if ($text -and -not $text.EndsWith("`n")) { $text += "`r`n" }
Write-Text $patch ($text + $block + "`r`n")
Write-Host 'usb-sync entry appended to cordis.patch.yml'
Write-Host 'Install finished. Restart DSH, then type /usbsync to check.'

