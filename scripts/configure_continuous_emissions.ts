/**
 * configure_continuous_emissions.ts
 * Launch-bootstrap helper (authority-only). Runs the two txs that turn on the
 * continuous oSOLA emission for ONE house pool, with an on-chain expiry window:
 *   1. set_pool_rewards(pool, true)                  — flag the pool eligible
 *   2. configure_continuous_emissions(rate, epochs)  — global rate + auto-sunset
 *
 * The rate is PER POOL. Keep a single house pool enabled, otherwise total
 * emission = (#enabled pools) × rate.
 *
 * Run with transpile-only (repo tsconfig has no resolveJsonModule):
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/configure_continuous_emissions.ts [args]
 *
 * Usage:
 *   … --pool <poolPubkey> [opts]
 *   … --mint-a <mint> --mint-b <mint> [opts]
 *
 * Launch (250k oSOLA/epoch on the house pool for 4 epochs, the agreed default):
 *   ANCHOR_PROVIDER_URL=<rpc> TS_NODE_TRANSPILE_ONLY=1 \
 *     npx ts-node scripts/configure_continuous_emissions.ts --pool <housePool>
 *
 * Options:
 *   --osola-per-epoch <N>   oSOLA/epoch to emit on the pool   (default 250000)
 *   --epochs <N>            bootstrap window length in epochs  (default 4)
 *   --disable              revoke the pool + set rate 0 (emergency off)
 *   --dry-run              compute + print everything, send nothing
 *
 * RPC: set ANCHOR_PROVIDER_URL (e.g. the Helius devnet URL). Falls back to
 * NEXT_PUBLIC_RPC_URL in app/.env.local, then localnet.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import idl from "../target/idl/soladrome.json";

const PROGRAM_ID     = new PublicKey("4d2SYx8Dzv5A4X5FcHtvNhTFM582DFcioapnaSUQnLQd");
const STATE_SEED     = Buffer.from("state");
const AMM_POOL_SEED  = Buffer.from("amm_pool");
const EPOCH_DURATION = 604_800; // seconds (7 days) — must match on-chain
const DECIMALS       = 1_000_000; // 6 dp

// ── tiny flag parser ──────────────────────────────────────────────────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function resolveRpc(): string {
  if (process.env.ANCHOR_PROVIDER_URL) return process.env.ANCHOR_PROVIDER_URL;
  try {
    const env = fs.readFileSync(path.join(__dirname, "../app/.env.local"), "utf-8");
    const m = env.match(/^NEXT_PUBLIC_RPC_URL=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* ignore */ }
  return "http://127.0.0.1:8899";
}

function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) <= 0 ? [a, b] : [b, a];
}

async function main() {
  // ── resolve the pool ────────────────────────────────────────────────────────
  let pool: PublicKey;
  const poolArg = flag("pool");
  const mintA = flag("mint-a");
  const mintB = flag("mint-b");
  if (poolArg) {
    pool = new PublicKey(poolArg);
  } else if (mintA && mintB) {
    const [a, b] = sortMints(new PublicKey(mintA), new PublicKey(mintB));
    [pool] = PublicKey.findProgramAddressSync(
      [AMM_POOL_SEED, a.toBuffer(), b.toBuffer()], PROGRAM_ID
    );
  } else {
    console.error(
      "Usage: ts-node scripts/configure_continuous_emissions.ts " +
      "(--pool <pubkey> | --mint-a <mint> --mint-b <mint>) " +
      "[--osola-per-epoch 250000] [--epochs 4] [--disable] [--dry-run]"
    );
    process.exit(1);
    return;
  }

  const disable = has("disable");
  const dryRun  = has("dry-run");
  const osolaPerEpoch = parseFloat(flag("osola-per-epoch") ?? "250000");
  const epochs        = parseInt(flag("epochs") ?? "4", 10);

  // rate (base units / second) = osolaPerEpoch * 1e6 / EPOCH_DURATION
  const ratePerSec = disable
    ? 0
    : Math.round((osolaPerEpoch * DECIMALS) / EPOCH_DURATION);
  const durationEpochs = disable ? 0 : epochs;

  if (ratePerSec > 0xffff_ffff) {
    console.error(`rate_per_sec ${ratePerSec} exceeds u32::MAX — lower --osola-per-epoch`);
    process.exit(1);
  }

  // ── provider / program ──────────────────────────────────────────────────────
  const walletPath = process.env.ANCHOR_WALLET
    ?? path.join(process.env.HOME!, ".config/solana/id.json");
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
  );
  const rpc = resolveRpc();
  const connection = new Connection(rpc, "confirmed");
  const provider   = new AnchorProvider(connection, new anchor.Wallet(kp), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new Program(idl as any, provider);

  const [statePda] = PublicKey.findProgramAddressSync([STATE_SEED], PROGRAM_ID);
  const state: any = await (program.account as any).protocolState.fetch(statePda);

  const nowSec      = Math.floor(Date.now() / 1000);
  const currentEpoch = Math.floor(nowSec / EPOCH_DURATION);
  const endEpoch     = disable ? 0 : currentEpoch + durationEpochs;

  // ── pre-flight checks ───────────────────────────────────────────────────────
  console.log("── plan ─────────────────────────────────────────────");
  console.log("RPC                :", rpc);
  console.log("signer (authority) :", kp.publicKey.toBase58());
  console.log("state.authority    :", state.authority.toBase58());
  console.log("pool               :", pool.toBase58());
  console.log("action             :", disable ? "DISABLE (revoke + rate 0)" : "ENABLE bootstrap");
  if (!disable) {
    console.log(`oSOLA / epoch      : ${osolaPerEpoch.toLocaleString()} (per pool)`);
    console.log(`rate_per_sec       : ${ratePerSec} base units/s`);
    console.log(`  → effective       ≈ ${((ratePerSec * EPOCH_DURATION) / DECIMALS).toLocaleString()} oSOLA/epoch`);
    console.log(`window             : ${durationEpochs} epochs  (epoch ${currentEpoch} → ${endEpoch} exclusive)`);
    console.log(`auto-off at        ≈ ${new Date(endEpoch * EPOCH_DURATION * 1000).toISOString()}`);
  }
  console.log("─────────────────────────────────────────────────────");

  if (state.authority.toBase58() !== kp.publicKey.toBase58()) {
    console.error("❌ signer is NOT protocol_state.authority — aborting (would revert on-chain).");
    process.exit(1);
  }
  if (endEpoch > 0xffff) {
    console.error(`❌ end_epoch ${endEpoch} exceeds u16::MAX — on-chain storage cannot hold it.`);
    process.exit(1);
  }

  // verify the pool account exists & is owned by the program
  const poolInfo = await connection.getAccountInfo(pool);
  if (!poolInfo) { console.error("❌ pool account not found on this cluster."); process.exit(1); }
  if (!poolInfo.owner.equals(PROGRAM_ID)) {
    console.error("❌ pool is not owned by the Soladrome program."); process.exit(1);
  }

  if (dryRun) { console.log("\n--dry-run: nothing sent."); return; }

  // ── tx 1: set_pool_rewards ──────────────────────────────────────────────────
  console.log(`\n[1/2] set_pool_rewards(${!disable}) …`);
  const tx1 = await program.methods
    .setPoolRewards(!disable)
    .accounts({
      authority:     kp.publicKey,
      protocolState: statePda,
      pool,
    } as any)
    .rpc();
  console.log("      ✅ tx:", tx1);

  // ── tx 2: configure_continuous_emissions ────────────────────────────────────
  console.log(`\n[2/2] configure_continuous_emissions(rate=${ratePerSec}, epochs=${durationEpochs}) …`);
  const tx2 = await program.methods
    .configureContinuousEmissions(new BN(ratePerSec), new BN(durationEpochs))
    .accounts({
      authority:     kp.publicKey,
      protocolState: statePda,
    } as any)
    .rpc();
  console.log("      ✅ tx:", tx2);

  // ── read back ───────────────────────────────────────────────────────────────
  const after: any  = await (program.account as any).protocolState.fetch(statePda);
  const poolAfter: any = await (program.account as any).ammPool.fetch(pool);
  console.log("\n── on-chain after ───────────────────────────────────");
  console.log("continuous_rate_per_sec :", after.continuousRatePerSec);
  console.log("continuous_end_epoch    :", after.continuousEndEpoch, `(current ${currentEpoch})`);
  console.log("pool.rewards_enabled    :", poolAfter.rewardsEnabled);
  console.log("─────────────────────────────────────────────────────");
  console.log(disable
    ? "✅ Continuous emissions disabled."
    : `✅ Bootstrap live — pool emits ~${osolaPerEpoch.toLocaleString()} oSOLA/epoch until epoch ${endEpoch}, then auto-stops.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
