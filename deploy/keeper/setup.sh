#!/usr/bin/env bash
# One-time bootstrap of a fresh Ubuntu 24.04 / Debian 12 server for the keeper. Run as root.
# deploy.sh runs it for you on the first deploy; running it again is harmless.
#
# What it does, and nothing else: firewall (SSH only, nothing listens), key-only SSH, automatic
# security updates, Node from nodejs.org verified against its published checksum, a system user
# with no shell, and the systemd unit.
set -euo pipefail

NODE_VERSION="v22.23.2"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q curl ca-certificates xz-utils ufw unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

# Firewall: the keeper only makes outbound calls. Nothing needs to reach it but SSH.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

# Key-only SSH. Safe to apply here: this script arrives over a key-authenticated session.
install -d /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-soladrome-keeper.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl reload ssh 2>/dev/null || systemctl reload sshd

# Node, pinned, verified. Ubuntu's own nodejs package is too old for the bundle.
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  tarball="node-${NODE_VERSION}-linux-${arch}.tar.xz"
  tmp="$(mktemp -d)"
  curl -fsSLo "$tmp/$tarball" "https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
  curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi
/usr/local/bin/node --version

# A user that can run the keeper and do nothing else.
id keeper >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin keeper
install -d -o root -g keeper -m 750 /opt/soladrome-keeper /etc/soladrome-keeper

install -m 644 "$(dirname "$0")/soladrome-keeper.service" /etc/systemd/system/soladrome-keeper.service
systemctl daemon-reload
systemctl enable soladrome-keeper.service

touch /etc/soladrome-keeper/.setup-done
echo "setup done"
