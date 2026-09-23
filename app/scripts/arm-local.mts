// Arm a standing order from a keypair file — the terminal counterpart of the Rewards card.
// Exists so the whole cycle can be proven before anyone is asked to click it, on whichever
// cluster `KEEPER_RPC_URL` names.
//   KEEPER_RPC_URL=http://127.0.0.1:8899 ARM_KEYPAIR=~/.config/solana/id.json \
//   ARM_CHUNK=10 ARM_ROUNDS=3 node --import ./scripts/json-loader.mjs scripts/arm-local.mts
// Add ARM_LP_POOL=<pool address> (and optionally ARM_MIN_PCT=70) to compound into liquidity
// instead of voting power — the same `buildArmInstructions` the card calls, same destination.
import { readFileSync } from "node:fs";
import { AnchorProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { statePda, getProgram } from "../lib/program.ts";
import { buildArmInstructions, readStandingOrder } from "../lib/autocompound.ts";

const RPC = process.env.KEEPER_RPC_URL ?? "http://127.0.0.1:8899";
const path = (process.env.ARM_KEYPAIR ?? "~/.config/solana/id.json").replace("~", process.env.HOME!);
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const connection = new Connection(RPC, "confirmed");

const wallet = {
  publicKey: kp.publicKey,
  signTransaction: async (tx: Transaction) => { tx.partialSign(kp); return tx; },
  signAllTransactions: async (txs: Transaction[]) => { txs.forEach((t) => t.partialSign(kp)); return txs; },
};

const program = getProgram(new AnchorProvider(connection, wallet as any, {}));
const state: any = await (program.account as any).protocolState.fetch(statePda);

const chunk = Number(process.env.ARM_CHUNK ?? 500);
const ixs = await buildArmInstructions(connection, wallet as any, state.usdcMint, {
  threshold: chunk,
  chunk,
  maxCostPerUnit: Number(process.env.ARM_MAX_COST ?? 1.1),
  minInterval: Number(process.env.ARM_INTERVAL ?? 60), // 60 = MIN_CRANK_INTERVAL, the smallest the program accepts
  rounds: Number(process.env.ARM_ROUNDS ?? 5),
  maxFeeBps: Number(process.env.ARM_MAX_FEE_BPS ?? 0),
  budgetUsdc: Number(process.env.ARM_BUDGET ?? chunk * Number(process.env.ARM_ROUNDS ?? 5) * 1.1),
  destination: process.env.ARM_LP_POOL
    ? {
        kind: "lp",
        pool: new PublicKey(process.env.ARM_LP_POOL),
        minIntrinsicBps: Math.round(Number(process.env.ARM_MIN_PCT ?? 70) * 100),
      }
    : { kind: "vote" },
});
const tx = new Transaction().add(...ixs);
tx.feePayer = kp.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.sign(kp);
const sig = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(sig, "confirmed");
console.log(`armed for ${kp.publicKey.toBase58()} — ${sig.slice(0, 20)}…`);

const { order, allowances } = await readStandingOrder(connection, wallet as any, state.usdcMint);
console.log(
  `order: fires at ${order?.threshold} oSOLA, ${order?.chunk} per round, ` +
    (order?.lpTarget
      ? `into ${order.lpTarget.toBase58()} at ≥ ${order.minIntrinsicBps / 100}% of exercise value`
      : `into voting power, ceiling ${order?.maxCostPerUnit} USDC/oSOLA`),
);
console.log(`allowance: ${Number(allowances.oSola) / 1e6} oSOLA, ${Number(allowances.usdc) / 1e6} USDC`);
