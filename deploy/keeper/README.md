# Keeper on a VPS

The keeper (`app/scripts/keeper.mts`) fires the permissionless cranks: standing orders and
per-position strategies. It holds no authority on chain, so all it needs is to **keep
running**. This directory turns it into one bundled file (`yarn build:keeper`, 2.5 MB, no
`node_modules`) run by a systemd unit that restarts it forever. See `MAINNET_RUNBOOK.md` §7 for
why this matters.

## Cost

The cheapest reliable option is **Hetzner CX23** (2 vCPU, 4 GB RAM, Germany/Finland): about
€5.49/month excluding VAT, with IPv4, September 2026. That is far more than the keeper needs
(~150 MB RAM, near-zero CPU), but it is the entry plan. Keep the IPv4: IPv6-only saves €0.50
but not every RPC endpoint answers over IPv6.

The free alternative, Oracle Cloud Always Free, is not recommended: its sign-up often refuses
cards, and it reclaims instances it considers idle. A keeper looks idle.

Either way, the SOL the keeper spends on fees is separate: ~10 000 lamports per round
(runbook §7, item 4).

## First deploy

1. **An SSH key**, if you have none (`ls ~/.ssh`). Choose a passphrase:
   ```bash
   ssh-keygen -t ed25519 -C soladrome-keeper
   ```
2. **The server.** Hetzner Cloud Console → new project → Add server: **Ubuntu 24.04**, type
   **CX23**, location Falkenstein, Nuremberg or Helsinki. Paste `~/.ssh/id_ed25519.pub` under
   SSH keys. Note the IPv4 address.
3. **Optional, free alerting.** At healthchecks.io, create a check with period 5 min and grace
   5 min, then copy its ping URL. If a pass has not pinged it in 10 minutes (process dead,
   machine down, network cut), you get an email.
4. **Deploy**, from your machine:
   ```bash
   HEARTBEAT_URL=https://hc-ping.com/<uuid> deploy/keeper/deploy.sh root@<ipv4>
   ```
   The first run bootstraps the server with `setup.sh`: firewall (SSH only), key-only SSH,
   automatic security updates, Node 22 verified against nodejs.org's checksum, and a `keeper`
   user with no shell. Every run then rebuilds the bundle, installs it with the fee-payer
   keypair and `RPC_URL` (sent over SSH on stdin, mode 640), restarts the service and prints
   its first log lines.
5. **Stop any other keeper** you run locally. Two keepers are harmless, since the chain refuses
   the second crank, but they pay for two simulations each.

`deploy.sh` refuses the deployer / upgrade-authority key by name. The fee payer defaults to
`~/.config/solana/keeper-devnet.json`; set `KEEPER_KEYPAIR_FILE` for another one.

## Operating it

```bash
ssh root@<ipv4> journalctl -u soladrome-keeper -f              # live log
ssh root@<ipv4> systemctl restart soladrome-keeper
ssh root@<ipv4> systemctl stop soladrome-keeper
```

To update after a change to the keeper or `app/lib/`, run `deploy.sh` again.

Keep the fee payer funded: `solana balance <pubkey>`. On devnet, airdrop to it. On mainnet,
top it up from the treasury, and use a mainnet throwaway key and a mainnet server `RPC_URL`.
