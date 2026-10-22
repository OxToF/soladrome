#!/usr/bin/env bash
# Build the keeper and ship it to a server. Run from anywhere in the repo, on your machine:
#
#   deploy/keeper/deploy.sh root@<server-ip>
#
# Optional environment:
#   KEEPER_KEYPAIR_FILE   fee-payer keypair to install (default ~/.config/solana/keeper-devnet.json)
#   HEARTBEAT_URL         healthchecks.io ping URL, written to the server's keeper.env
#   KEEPER_RPC_URL        the keeper's own RPC endpoint (else KEEPER_RPC_URL in app/.env.local);
#                         required, and refused if it equals the site's RPC_URL
#
# The first run bootstraps the server (setup.sh). Every run rebuilds the bundle, installs it,
# rewrites keeper.env and restarts the service. Secrets travel over SSH on stdin, never as
# command-line arguments, so they appear in no process list and no shell history.
set -euo pipefail

HOST="${1:?usage: deploy/keeper/deploy.sh root@<server-ip>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
KEYPAIR="${KEEPER_KEYPAIR_FILE:-$HOME/.config/solana/keeper-devnet.json}"
NODE24="${NODE24:-$HOME/.nvm/versions/node/v24.19.0/bin}"

# ☢️ Never ship a key with authority. The upgrade authority / deployer is refused by name.
FORBIDDEN="2BhwbPGjRcoYv98jLJpkk6khjZX1oW97kSixUge2xTfB"
PUBKEY="$("$NODE24/node" -e '
  const { Keypair } = require(process.argv[2] + "/app/node_modules/@solana/web3.js");
  const k = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))));
  console.log(k.publicKey.toBase58());' "$KEYPAIR" "$ROOT")"
if [ "$PUBKEY" = "$FORBIDDEN" ]; then
  echo "refusing: $KEYPAIR is the deployer / upgrade authority. Give the keeper a funded throwaway." >&2
  exit 1
fi
echo "fee payer: $PUBKEY"

# ☢️ The keeper gets its OWN key, from its OWN Helius account. Helius counts credits per
# account, not per key: on 2026-10-21 a keeper polling once a minute on the site's `RPC_URL`
# drained the shared quota and every server route, the faucet first, answered
# "429 max usage reached". A second key in the same account is born exhausted.
# So no fallback to `RPC_URL`: a silent fallback is exactly how the two got shared.
SITE_RPC_URL="$(grep -E '^RPC_URL=' "$ROOT/app/.env.local" | cut -d= -f2- || true)"
KEEPER_RPC_URL="${KEEPER_RPC_URL:-$(grep -E '^KEEPER_RPC_URL=' "$ROOT/app/.env.local" | cut -d= -f2- || true)}"
[ -n "$KEEPER_RPC_URL" ] || {
  echo "no KEEPER_RPC_URL: export it or add it to app/.env.local (a key from a Helius account the site does not use)" >&2
  exit 1
}
if [ "$KEEPER_RPC_URL" = "$SITE_RPC_URL" ]; then
  echo "refusing: KEEPER_RPC_URL is the site's RPC_URL. The keeper would drain the site's quota." >&2
  exit 1
fi

echo "building the bundle"
(cd "$ROOT/app" && PATH="$NODE24:$PATH" yarn -s build:keeper)

if ! ssh "$HOST" test -f /etc/soladrome-keeper/.setup-done; then
  echo "first deploy: bootstrapping the server"
  ssh "$HOST" 'rm -rf /tmp/soladrome-keeper-setup && mkdir -p /tmp/soladrome-keeper-setup'
  scp -q "$HERE/setup.sh" "$HERE/soladrome-keeper.service" "$HOST:/tmp/soladrome-keeper-setup/"
  ssh "$HOST" 'bash /tmp/soladrome-keeper-setup/setup.sh && rm -rf /tmp/soladrome-keeper-setup'
else
  # Keep the unit current on later deploys.
  scp -q "$HERE/soladrome-keeper.service" "$HOST:/tmp/soladrome-keeper.service"
  ssh "$HOST" 'install -m 644 /tmp/soladrome-keeper.service /etc/systemd/system/ && rm /tmp/soladrome-keeper.service && systemctl daemon-reload'
fi

echo "installing"
scp -q "$ROOT/deploy/keeper/dist/keeper.mjs" "$HOST:/tmp/keeper.mjs"
ssh "$HOST" 'install -o root -g keeper -m 640 /tmp/keeper.mjs /opt/soladrome-keeper/keeper.mjs && rm /tmp/keeper.mjs'
ssh "$HOST" 'umask 077 && cat > /etc/soladrome-keeper/keypair.json && chown root:keeper /etc/soladrome-keeper/keypair.json && chmod 640 /etc/soladrome-keeper/keypair.json' < "$KEYPAIR"
printf 'KEEPER_RPC_URL=%s\nKEEPER_KEYPAIR=/etc/soladrome-keeper/keypair.json\nKEEPER_HEARTBEAT_URL=%s\n' "$KEEPER_RPC_URL" "${HEARTBEAT_URL:-}" |
  ssh "$HOST" 'umask 077 && cat > /etc/soladrome-keeper/keeper.env && chown root:keeper /etc/soladrome-keeper/keeper.env && chmod 640 /etc/soladrome-keeper/keeper.env'

ssh "$HOST" 'systemctl restart soladrome-keeper && sleep 20 && systemctl is-active soladrome-keeper && journalctl -u soladrome-keeper -n 15 --no-pager -o cat'
