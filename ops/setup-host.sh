#!/usr/bin/env bash
# Run through Session Manager as root on the AL2023 ARM64 instance (#35).
set -euo pipefail
version=${1:?Usage: setup-host.sh NODE_VERSION NODE_ARCHIVE_SHA256}
checksum=${2:?Supply the reviewed SHA256 of the official linux-arm64 archive}
[[ $version =~ ^26\.[0-9]+\.[0-9]+$ && $checksum =~ ^[a-f0-9]{64}$ ]]
[[ $EUID == 0 && $(uname -m) == aarch64 ]]
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == amzn && $VERSION_ID == 2023 ]]
for environment in staging production; do
  if systemctl is-active --quiet "ygo@$environment"; then
    echo "Stop both YGo units before changing the host runtime" >&2
    exit 1
  fi
done
dnf install -y nginx postgresql17 python3.12 awscli-2 tar xz
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
curl -fsS "https://nodejs.org/dist/v$version/node-v$version-linux-arm64.tar.xz" -o "$scratch/node.tar.xz"
printf '%s  %s\n' "$checksum" "$scratch/node.tar.xz" | sha256sum --check --strict
install -d -m 0755 /opt/ygo/node /var/log/ygo
# Only run setup with both API units stopped when upgrading the runtime.
tar -xJf "$scratch/node.tar.xz" -C /opt/ygo/node --strip-components=1
/opt/ygo/node/bin/node --version
install -d -m 0755 /etc/ygo
curl -fsS https://truststore.pki.rds.amazonaws.com/ap-south-1/ap-south-1-bundle.pem -o /etc/ygo/rds-ca.pem
chmod 0644 /etc/ygo/rds-ca.pem
for environment in staging production; do
  id "ygo-$environment" >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin "ygo-$environment"
  install -d -o root -g "ygo-$environment" -m 0750 "/opt/ygo/$environment" "/opt/ygo/$environment/releases"
done
install -m 0644 "$(dirname "$0")/ygo@.service" /etc/systemd/system/ygo@.service
python3.12 -m venv /opt/certbot
/opt/certbot/bin/pip install certbot certbot-nginx
systemctl daemon-reload
systemctl enable --now amazon-ssm-agent nginx
# Units stay off until secrets, migrations and a release are ready.
