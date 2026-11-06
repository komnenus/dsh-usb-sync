#Requires -Version 5.1
<#
  Push this folder to a GitHub repository.

    push-to-github.ps1 -User <GitHub user name>
    push-to-github.ps1 -User <user> -Repo dsh-usb-sync -Branch main

  The repository must already exist on GitHub (create it empty: no README,
  no .gitignore, no license). The first push opens the browser sign-in.
#>
param(
    [Parameter(Mandatory = $true)][string]$User,
    [string]$Repo = 'dsh-usb-sync',
    [string]$Branch = 'main',
    [string]$Remote = 'origin'
)
$ErrorActionPreference = 'Stop'

$dir = $PSScriptRoot
$url = "https://github.com/$User/$Repo.git"

Write-Host "folder : $dir"
Write-Host "remote : $url"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not installed' }
& git -C $dir rev-parse --verify HEAD *> $null
if ($LASTEXITCODE -ne 0) { throw 'this folder has no commit yet' }
$current = (& git -C $dir branch --show-current).Trim()
if ($current -ne $Branch) { throw "current branch is '$current', expected '$Branch'" }

$existing = ''
& git -C $dir remote get-url $Remote 2>$null | ForEach-Object { $existing = "$_".Trim() }
if ($existing) {
    if ($existing -ne $url) {
        Write-Host "replacing remote $Remote ($existing)"
        & git -C $dir remote set-url $Remote $url
    } else {
        Write-Host "remote $Remote already points there"
    }
} else {
    & git -C $dir remote add $Remote $url
    Write-Host "remote $Remote added"
}

Write-Host ''
Write-Host 'pushing ... (the first time a browser sign-in may open)'
& git -C $dir push -u $Remote $Branch
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'push failed. common causes:' -ForegroundColor Yellow
    Write-Host '  - the repository does not exist yet, or user/repo name is misspelled'
    Write-Host '  - you signed in with a different GitHub account'
    Write-Host '  - the repository already has a README/license commit: run git pull --rebase origin main, then push again'
    exit 1
}

Write-Host ''
Write-Host "done: https://github.com/$User/$Repo" -ForegroundColor Green
