$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$product = Get-Content (Join-Path $root 'package.json') | ConvertFrom-Json
$app = Join-Path $root "out/Synax-win32-x64/Synax.exe"
$installer = Join-Path $root "out/make/nsis/Synax-$($product.version)-win32-x64-NSIS.exe"
$expected = $env:SYNAX_WINDOWS_PUBLISHER
if (!$expected) { throw 'SYNAX_WINDOWS_PUBLISHER is missing.' }
$certificate = Join-Path $root '.signing/windows/Synax.cer'
if (!(Test-Path -LiteralPath $certificate)) { throw "Missing self-signed publisher certificate: $certificate" }
certutil.exe -user -addstore -f TrustedPublisher $certificate | Out-Null
try {
  foreach ($file in @($app, $installer)) {
    if (!(Test-Path -LiteralPath $file)) { throw "Missing signed Windows artifact: $file" }
    $signature = Get-AuthenticodeSignature -FilePath $file
    if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature for ${file}: $($signature.Status)" }
    if ($signature.SignerCertificate.Subject -notlike "*$expected*") {
      throw "Unexpected signer for ${file}: $($signature.SignerCertificate.Subject)"
    }
  }
} finally {
  $certificateInfo = Get-PfxCertificate -FilePath $certificate
  certutil.exe -user -delstore TrustedPublisher $certificateInfo.Thumbprint | Out-Null
}
Write-Host "Verified Authenticode signatures for Synax.exe and the NSIS installer."
