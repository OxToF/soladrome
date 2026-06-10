/**
 * attest-velo.cjs
 *
 * Atteste VELO (Optimism) sur Solana via le Wormhole Token Bridge.
 * À exécuter UNE SEULE FOIS — crée le mint wVELO (SPL) sur Solana mainnet.
 *
 * Usage :
 *   node scripts/attest-velo.cjs                        # attestation complète
 *   node scripts/attest-velo.cjs --txhash 0x7b16db...   # reprend depuis une tx Optimism existante
 *
 * Variables d'environnement requises (dans scripts/.env.attest) :
 *   EVM_PRIVATE_KEY   — clé privée Optimism (hex, sans 0x)
 *   SOLANA_KEYPAIR    — chemin vers ton fichier keypair JSON Solana
 *
 * Coût : ~0.000015 ETH sur Optimism  +  ~0.012 SOL sur Solana
 * Résultat : wVELO SPL mint → 7aTLRjZyYkRGHqsRHDcvSWrQHPGqAwiwhF2nS9deHDdY
 */

"use strict";

const path = require("path");
const fs   = require("fs");

// ── Parse args ───────────────────────────────────────────────────────────────
const resumeTxHash = (() => {
  const idx = process.argv.indexOf("--txhash");
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// ── Load .env.attest ─────────────────────────────────────────────────────────
const envPath = path.join(__dirname, ".env.attest");
if (!fs.existsSync(envPath)) {
  console.error(`\n❌  Fichier manquant : ${envPath}`);
  console.error(`Crée-le avec :\n  EVM_PRIVATE_KEY=<ta_clé_hex>\n  SOLANA_KEYPAIR=<chemin_keypair.json>\n`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const [k, ...v] = line.trim().split("=");
  if (k && !k.startsWith("#")) process.env[k] = v.join("=");
}

const EVM_KEY      = process.env.EVM_PRIVATE_KEY;
const KEYPAIR_PATH = process.env.SOLANA_KEYPAIR;

if (!EVM_KEY || !KEYPAIR_PATH) {
  console.error("❌  EVM_PRIVATE_KEY et SOLANA_KEYPAIR requis dans .env.attest");
  process.exit(1);
}

// ── Imports ──────────────────────────────────────────────────────────────────
const { wormhole, toUniversal }              = require("@wormhole-foundation/sdk");
const evmPlatform  = require("@wormhole-foundation/sdk/evm").default;
const solPlatform  = require("@wormhole-foundation/sdk/solana").default;
const { getEvmSignerForKey }                 = require("@wormhole-foundation/sdk-evm");
const { getSolanaSignAndSendSigner }         = require("@wormhole-foundation/sdk-solana");
const { Keypair, Connection }                = require("@solana/web3.js");
const { ethers }                             = require("ethers");

// ── Constants ─────────────────────────────────────────────────────────────────
const VELO_OPTIMISM     = "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db";
const WVELO_SOLANA      = "7aTLRjZyYkRGHqsRHDcvSWrQHPGqAwiwhF2nS9deHDdY";
const OP_TOKEN_BRIDGE   = "0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b";
const OP_CORE_BRIDGE    = "0xEe91C335eab126dF5fDB3797EA9d6aD93aeC9722";
const OP_RPC            = "https://mainnet.optimism.io";
const SOL_RPC           = process.env.SOLANA_RPC ?? "https://rpc.ankr.com/solana";

// LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)
const LOG_MSG_TOPIC = "0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2";

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWormholeMessageIdFromTx(txHash) {
  const provider = new ethers.JsonRpcProvider(OP_RPC);
  const receipt  = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`Tx ${txHash} introuvable sur Optimism`);

  const log = receipt.logs.find(l =>
    l.address.toLowerCase() === OP_CORE_BRIDGE.toLowerCase() &&
    l.topics[0] === LOG_MSG_TOPIC
  );
  if (!log) throw new Error("Événement LogMessagePublished introuvable dans la tx");

  // ABI decode: sequence (uint64) is first non-indexed field
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint64", "uint32", "bytes", "uint8"],
    log.data
  );
  const sequence = decoded[0]; // BigInt

  return {
    chain:    "Optimism",
    emitter:  toUniversal("Optimism", OP_TOKEN_BRIDGE),
    sequence: sequence,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🔶  Wormhole VELO Attestation — Optimism → Solana\n");

  // 1. SDK init
  console.log("1/5  Initialisation Wormhole SDK (Mainnet)…");
  const wh = await wormhole("Mainnet", [evmPlatform, solPlatform]);

  // 2. Signers
  console.log("2/5  Création des signers…");
  const opChain  = wh.getChain("Optimism");
  const solChain = wh.getChain("Solana");

  const evmSigner = await getEvmSignerForKey(await opChain.getRpc(), EVM_KEY);
  console.log(`     EVM  → ${evmSigner.address()}`);

  const kp        = loadKeypair(KEYPAIR_PATH);
  const solConn   = new Connection(SOL_RPC, "confirmed");
  const solSigner = await getSolanaSignAndSendSigner(solConn, kp);
  console.log(`     SOL  → ${kp.publicKey.toBase58()}`);

  // 3. Attestation sur Optimism (ou reprise depuis txhash existant)
  let txHash = resumeTxHash;

  if (!txHash) {
    console.log("\n3/5  Envoi de l'attestation sur Optimism…");
    const opTb   = await opChain.getTokenBridge();
    const { signSendWait } = require("@wormhole-foundation/sdk");
    const txids  = await signSendWait(opChain, opTb.createAttestation(VELO_OPTIMISM, evmSigner.address()), evmSigner);
    txHash = txids[txids.length - 1].txid;
    console.log(`     ✅  Tx Optimism : https://optimistic.etherscan.io/tx/${txHash}`);
  } else {
    console.log(`\n3/5  Reprise depuis tx Optimism existante :\n     ${txHash}`);
  }

  // 4. Extraire le WormholeMessageId depuis le reçu de tx
  console.log("\n4/5  Lecture du WormholeMessageId depuis la tx…");
  const msgId = await getWormholeMessageIdFromTx(txHash);
  console.log(`     chain=${msgId.chain}  sequence=${msgId.sequence}`);

  // 5. Attente du VAA
  console.log("\n5/5  Attente du VAA Wormhole (peut prendre 10-20 min)…");
  let vaa;
  const timeout = 30 * 60 * 1000;
  const start   = Date.now();

  while (Date.now() - start < timeout) {
    try {
      vaa = await wh.getVaa(msgId, "TokenBridge:AttestMeta", 10_000);
      if (vaa) break;
    } catch (_) {}
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r     ⏳  ${elapsed}s écoulées…`);
    await sleep(15_000);
  }

  if (!vaa) {
    console.error("\n❌  Timeout. Relance avec :");
    console.error(`    node scripts/attest-velo.cjs --txhash ${txHash}\n`);
    process.exit(1);
  }
  console.log("\n     ✅  VAA reçu !");

  // 6. Soumission sur Solana → crée le mint wVELO
  console.log("\n6/6  Création du mint wVELO sur Solana…");
  const { signSendWait } = require("@wormhole-foundation/sdk");
  const solTb    = await solChain.getTokenBridge();
  const solTxids = await signSendWait(solChain, solTb.submitAttestation(vaa, kp.publicKey), solSigner);
  const solTx    = solTxids[solTxids.length - 1].txid;
  console.log(`     ✅  Tx Solana : https://solscan.io/tx/${solTx}`);

  console.log("\n🎉  Attestation terminée !");
  console.log(`    wVELO SPL mint : ${WVELO_SOLANA}`);
  console.log("    Le bridge VELO → wVELO est maintenant ouvert pour tout le monde.\n");
}

main().catch(async err => {
  console.error("\n❌  Erreur :", err.message ?? err);
  if (typeof err.getLogs === "function") {
    try {
      const logs = await err.getLogs();
      console.error("\n📋  Logs Solana :\n", logs?.join("\n"));
    } catch (_) {}
  }
  if (err.logs) console.error("\n📋  Logs :\n", err.logs?.join("\n"));
  process.exit(1);
});
