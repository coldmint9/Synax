#!/usr/bin/env bash
set -euo pipefail
if [ -z "${SYNAX_MAC_CERTIFICATE:-}" ]; then
  exit 0
fi
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${SYNAX_MAC_CERTIFICATE_PASSWORD:?Certificate password is required}"
certificate="$RUNNER_TEMP/synax-signing.p12"
keychain="$RUNNER_TEMP/synax-signing.keychain-db"
keychain_password="$(openssl rand -hex 32)"
trap 'rm -f "$certificate"' EXIT
printf '%s' "$SYNAX_MAC_CERTIFICATE" | base64 --decode > "$certificate"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$certificate" -P "$SYNAX_MAC_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
security list-keychains -d user -s "$keychain" "$HOME/Library/Keychains/login.keychain-db"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain"
