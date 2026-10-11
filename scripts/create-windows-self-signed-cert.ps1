$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$outputPath = $env:SYNAX_SIGNING_PFX
$publicPath = $env:SYNAX_SIGNING_CER
$password = $env:SYNAX_SIGNING_PASSWORD
$publisher = $env:SYNAX_SIGNING_PUBLISHER
if (!$outputPath -or !$publicPath -or !$password -or !$publisher) {
  throw 'Missing Windows certificate preparation inputs.'
}
$securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
$generated = $null
$certificate = $null
try {
  if (!(Test-Path -LiteralPath $outputPath)) {
    if ($env:CI) { throw 'CI must reuse the persistent release certificate.' }
    if ($publisher -match '[,=\r\n]') { throw 'Use a simple publisher name when creating a self-signed certificate.' }
    $generated = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=$publisher" `
      -FriendlyName $publisher -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
      -KeyExportPolicy Exportable -CertStoreLocation Cert:\CurrentUser\My `
      -NotAfter (Get-Date).AddYears(10)
    Export-PfxCertificate -Cert $generated -FilePath $outputPath -Password $securePassword | Out-Null
  }
  # Ephemeral import validates the PFX without installing it into a trust store.
  $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $outputPath, $password, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
  if (!$certificate.HasPrivateKey) { throw 'PFX must contain the code signing private key.' }
  if ($certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw 'Code signing certificate is not currently valid.' }
  $eku = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' }
  if (!$eku -or !($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })) {
    throw 'Certificate must permit code signing.'
  }
  $commonName = $certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($publisher -ne $commonName -and $publisher -ne $certificate.Subject) { throw 'SYNAX_WINDOWS_PUBLISHER does not match the certificate.' }
  [System.IO.File]::WriteAllBytes($publicPath, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  @{ publisher = $certificate.Subject; thumbprint = $certificate.Thumbprint } | ConvertTo-Json -Compress
} finally {
  if ($certificate) { $certificate.Dispose() }
  if ($generated) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($generated.Thumbprint)" }
}
