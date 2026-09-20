$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path $PSScriptRoot -Parent
$product = Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$appRoot = Join-Path $projectRoot 'out/Synax-win32-x64'
$masterIcon = Join-Path $projectRoot 'electron/resources/icon.ico'

function Assert-BrandIcon([string] $Executable) {
    if (!(Test-Path $Executable)) { throw "Missing executable: $Executable" }
    $actualIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($Executable)
    $expectedIcon = [System.Drawing.Icon]::new($masterIcon, $actualIcon.Size)
    $actual = $actualIcon.ToBitmap()
    $expected = $expectedIcon.ToBitmap()
    try {
        $difference = 0L
        for ($y = 0; $y -lt $actual.Height; $y++) {
            for ($x = 0; $x -lt $actual.Width; $x++) {
                $a = $actual.GetPixel($x, $y)
                $b = $expected.GetPixel($x, $y)
                $difference += [Math]::Abs([int]$a.A - [int]$b.A)
                $difference += [Math]::Abs([int]$a.R - [int]$b.R)
                $difference += [Math]::Abs([int]$a.G - [int]$b.G)
                $difference += [Math]::Abs([int]$a.B - [int]$b.B)
            }
        }
        $average = $difference / ($actual.Width * $actual.Height * 4)
        if ($average -gt 1) { throw "Executable does not contain the Synax icon: $Executable (difference $average)" }
    } finally {
        $actual.Dispose(); $expected.Dispose(); $actualIcon.Dispose(); $expectedIcon.Dispose()
    }
}

function Assert-Product([string] $Executable, [string] $Name, [string] $Description) {
    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Executable)
    if ($info.ProductName -ne $Name -or $info.FileDescription -ne $Description) {
        throw "Incorrect Windows product metadata: $Executable"
    }
    if ($info.ProductVersion -notlike "$($product.version)*") { throw "Incorrect product version: $Executable" }
    Assert-BrandIcon $Executable
}

Assert-Product (Join-Path $appRoot 'Synax.exe') $product.productName $product.description
Assert-Product (Join-Path $appRoot 'resources/updater/Synax Updater.exe') 'Synax Updater' 'Software updater for the Synax AI coding workspace'
$installer = Join-Path $projectRoot "out/make/squirrel.windows/x64/Synax-$($product.version)-win32-x64-Setup.exe"
Assert-BrandIcon $installer
Write-Host 'Windows executable, installer and updater branding verified.'
