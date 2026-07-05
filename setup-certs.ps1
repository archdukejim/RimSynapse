# setup-certs.ps1
# Generates a self-signed certificate trusted by Windows for localhost HTTPS.
# Run once before starting the bridge server.

$ErrorActionPreference = "Stop"

$CERT_DIR  = $PSScriptRoot          # same folder as the script
$PFX_PATH  = Join-Path $CERT_DIR "certificate.pfx"
$PFX_PASS  = "rimmind-bridge"       # password for the .pfx bundle

# DNS names the certificate covers
$DnsNames  = @("localhost", "127.0.0.1")

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  RimMind Bridge - Certificate Setup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Create a self-signed certificate ──────────────────────────────────
Write-Host "[1/3] Creating self-signed certificate for: $($DnsNames -join ', ')..." -ForegroundColor Yellow

$cert = New-SelfSignedCertificate `
    -Subject        "CN=RimMind Bridge Localhost" `
    -DnsName        $DnsNames `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter       (Get-Date).AddYears(5) `
    -KeyAlgorithm   RSA `
    -KeyLength      2048 `
    -HashAlgorithm  SHA256 `
    -FriendlyName   "RimMind LM Studio Bridge" `
    -TextExtension  @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")  # Server Auth EKU

Write-Host "       Thumbprint: $($cert.Thumbprint)" -ForegroundColor Gray

# ── 2. Trust the certificate ─────────────────────────────────────────────
Write-Host "[2/3] Installing certificate into Trusted Root (CurrentUser)..." -ForegroundColor Yellow
Write-Host "       You may see a Windows security prompt - click YES to trust." -ForegroundColor Gray

$rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store(
    [System.Security.Cryptography.X509Certificates.StoreName]::Root,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
)
$rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
$rootStore.Add($cert)
$rootStore.Close()

Write-Host "       Certificate trusted successfully." -ForegroundColor Green

# ── 3. Export to .pfx for Node.js ────────────────────────────────────────
Write-Host "[3/3] Exporting certificate to: $PFX_PATH ..." -ForegroundColor Yellow

$securePass = ConvertTo-SecureString -String $PFX_PASS -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $PFX_PATH -Password $securePass | Out-Null

Write-Host "       Exported successfully." -ForegroundColor Green

# ── Done ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  Setup complete!" -ForegroundColor Green
Write-Host "  PFX password: $PFX_PASS" -ForegroundColor Green
Write-Host "  Now run:  npm run dev" -ForegroundColor Green
Write-Host "  Dashboard: https://localhost:3000" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
