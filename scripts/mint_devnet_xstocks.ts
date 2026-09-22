// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2026 Soladrome Labs
//
// Mint the devnet Token-2022 stock fixtures, and prove the admission gate on a live chain.
//
// WHY THIS EXISTS: `token_ext::require_supported_mint` has been the whole Token-2022 admission
// policy since 2026-09-01, and eight bankrun cases cover it. But devnet carried no Token-2022
// mint at all, so the feature was unobservable outside the test suite: nobody could open a
// stock/USDC pool, and nobody could watch the gate turn a bad mint away. A reviewer had to take
// the tests on faith. This script removes that gap by putting the fixtures on the chain.
//
// It mints two families:
//
//   • ADMITTED — the shape the real tokenized equities ship in: an *unarmed* transfer hook slot
//     plus a permanent delegate, with a pausable config and a scaled-UI config on two of them.
//     Every one of these is deliberately allowed by `token_ext.rs` and disclosed rather than
//     blocked, because refusing them would exclude the entire asset class.
//
//   • REFUSED — one mint per rejection branch: a transfer fee, an ARMED transfer hook, and
//     `DefaultAccountState::Frozen`. They exist to be turned away. `--pools` ends by attempting
//     `create_pool` on one of them and reporting the error the program returns, which is the
//     only demonstration of the gate that does not require reading Rust.
//
// ☢️  THE MINT AUTHORITIES ARE PUBLIC BY CONSTRUCTION. Each mint keypair is derived from a
//     hash of its symbol (see `fixtureKeypair`) so that re-running the script is idempotent
//     rather than littering the chain with a new set of mints every time. Anyone who reads this
//     file can therefore derive every secret key and mint an unbounded supply. That is
//     acceptable for a devnet fixture and catastrophic anywhere else. These mints must never be
//     created on mainnet, never be added to `LAUNCH_TOKENS`, and never be used as a bribe
//     reward mint in anything but a demo.
//
// ⚠️  The prices in the fixture table are round numbers chosen so a seeded pool reads sensibly
//     on screen. They are not quotes, they track nothing, and no part of the protocol reads
//     them. They exist only to set the initial reserve ratio.
//
// Usage:
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/mint_devnet_xstocks.ts
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/mint_devnet_xstocks.ts --pools --usdc 2000
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/mint_devnet_xstocks.ts --only TSLAx,GLDx
//   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/mint_devnet_xstocks.ts --dry-run
//
// `--pools` additionally needs `lp_enabled` open. The script checks it and prints the command
// rather than flipping a protocol flag behind your back:
//   npx ts-node scripts/set_phase_flags.ts lp=true      # ... and lp=false when you are done
//
// Output: `app/lib/devnet-xstocks.json`, which `app/lib/tokens.ts` folds into the token picker
// when the frontend is pointed at devnet. That file is generated — edit this table, not it.

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction,
  sendAndConfirmTransaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType, getMintLen, TYPE_SIZE, LENGTH_SIZE, AccountState,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction, createMintToInstruction,
  createInitializeTransferHookInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializePausableConfigInstruction,
  createInitializeScaledUiAmountConfigInstruction,
} from "@solana/spl-token";
import { pack, createInitializeInstruction, TokenMetadata } from "@solana/spl-token-metadata";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { envValue, redactRpc, serverRpcUrl } from "./lib/rpc";

// Mainnet's genesis hash. The guard below is a DENY-list rather than an allow-list on purpose:
// if this script is ever pointed somewhere unexpected it should still refuse the one cluster
// where these public-key mints would be a disaster, without depending on my knowing the
// genesis hash of wherever else it landed.
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const USDC_DEC = 1_000_000; // the protocol's USDC is 6 dp, mock included

// Deliberately NOT 6. A fixture that shared USDC's decimals would hide exactly the class of
// scaling bug this demo should expose: `decimalsForMint` falls back to 6 for anything it does
// not know, so a mismatched token renders at the wrong size, silently and plausibly.
const STOCK_DEC = 8;

// Matches the frontend defaults (Pools.tsx): 0.30 % swap fee, 20 % of it to the protocol.
const FEE_RATE_BPS = 30;
const PROTOCOL_FEE_BPS = 2_000;

type Profile =
  | "equity"        // unarmed hook + permanent delegate: the shape the real mints ship in
  | "equity_pause"  // ... and a pausable config, which the gate allows and discloses
  | "equity_scaled" // ... and a scaled-UI config, which is how a stock split is expressed
  | "trap_fee"      // transfer fee            → refused
  | "trap_hook"     // ARMED transfer hook     → refused
  | "trap_frozen";  // default-frozen accounts → refused

interface Fixture {
  symbol: string;
  name: string;
  profile: Profile;
  /** Round number, used only to set the seeded pool's reserve ratio. Not a quote. */
  demoPrice: number;
  /** What `token_ext::require_supported_mint` is expected to do with it. */
  admitted: boolean;
  why: string;
}

// The admitted set is the tokenized-equity shape plus two commodities, which is enough breadth
// for the pool list to look like a venue rather than a single test pair. The index entries are
// named after the ETFs (SPY, QQQ) and not the indices themselves (S&P 500, Nasdaq 100), because
// an index level is not a thing anyone can tokenize: what gets wrapped is the fund that tracks it.
const FIXTURES: Fixture[] = [
  { symbol: "TSLAx", name: "Tesla",        profile: "equity",        demoPrice: 400, admitted: true,  why: "unarmed hook slot + permanent delegate" },
  { symbol: "NVDAx", name: "Nvidia",       profile: "equity",        demoPrice: 180, admitted: true,  why: "unarmed hook slot + permanent delegate" },
  { symbol: "AAPLx", name: "Apple",        profile: "equity",        demoPrice: 230, admitted: true,  why: "unarmed hook slot + permanent delegate" },
  { symbol: "SPYx",  name: "S&P 500 ETF",  profile: "equity",        demoPrice: 600, admitted: true,  why: "unarmed hook slot + permanent delegate" },
  { symbol: "QQQx",  name: "Nasdaq 100 ETF", profile: "equity",      demoPrice: 500, admitted: true,  why: "unarmed hook slot + permanent delegate" },
  { symbol: "GLDx",  name: "Gold",         profile: "equity_pause",  demoPrice: 310, admitted: true,  why: "+ pausable: the issuer may freeze its own market, and that is its prerogative" },
  { symbol: "SLVx",  name: "Silver",       profile: "equity_scaled", demoPrice: 35,  admitted: true,  why: "+ scaled UI: a split changes the display, never the invariant" },

  { symbol: "BADFEE",  name: "Transfer-fee trap",  profile: "trap_fee",    demoPrice: 100, admitted: false, why: "the vault would receive less than the reserve just booked" },
  { symbol: "BADHOOK", name: "Armed-hook trap",    profile: "trap_hook",   demoPrice: 100, admitted: false, why: "every transfer would fail, remove_liquidity included" },
  { symbol: "BADFROZ", name: "Default-frozen trap", profile: "trap_frozen", demoPrice: 100, admitted: false, why: "the vault would be born unable to move a token" },
];

// Any pubkey at all, as long as it is not the default. The gate reads the hook's `program_id`
// field and refuses a non-default value; it never invokes the program, so this address does not
// have to exist or be executable. Hashed rather than typed so it is a valid 32-byte key by
// construction instead of by my counting base58 characters correctly.
const DUMMY_HOOK_PROGRAM = new PublicKey(createHash("sha256").update("soladrome:devnet-xstock:armed-hook").digest());

const flagValue = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const hasFlag = (n: string) => process.argv.includes(`--${n}`);

// ⚠️ `envValue` and the RPC preference used to be copy-pasted into every script here. They live
// in `scripts/lib/rpc.ts` now, because a single script still reaching for the BROWSER key
// defeats restricting that key to the domain — and a half-converted tree fails silently.



function loadKeypair(): Keypair {
  const kpPath = process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config", "solana", "id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
}

/// The mock-USDC mint authority. Never printed — only its derived pubkey is.
function loadFaucet(): Keypair {
  const raw = envValue("FAUCET_KEYPAIR");
  if (!raw) throw new Error("FAUCET_KEYPAIR missing from app/.env.local — needed to mint the mock USDC side of each pool");
  if (raw.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const bs58 = require("bs58");
  return Keypair.fromSecretKey((bs58.default ?? bs58).decode(raw));
}

/// Deterministic, so a second run finds the same mints instead of creating a parallel set.
/// ☢️ Derived from a public string: see the banner at the top of this file.
function fixtureKeypair(symbol: string): Keypair {
  return Keypair.fromSeed(Uint8Array.from(
    createHash("sha256").update(`soladrome:devnet-xstock:v1:${symbol}`).digest()));
}

function extensionsFor(p: Profile): ExtensionType[] {
  const base = [ExtensionType.MetadataPointer];
  switch (p) {
    case "equity":        return [...base, ExtensionType.TransferHook, ExtensionType.PermanentDelegate];
    case "equity_pause":  return [...base, ExtensionType.TransferHook, ExtensionType.PermanentDelegate, ExtensionType.PausableConfig];
    case "equity_scaled": return [...base, ExtensionType.TransferHook, ExtensionType.PermanentDelegate, ExtensionType.ScaledUiAmountConfig];
    case "trap_fee":      return [...base, ExtensionType.TransferFeeConfig];
    case "trap_hook":     return [...base, ExtensionType.TransferHook];
    case "trap_frozen":   return [...base, ExtensionType.DefaultAccountState];
  }
}

/// Extension initializers run AFTER `createAccount` and BEFORE `initializeMint`. The token
/// program rejects any other order.
function extensionIxs(p: Profile, mint: PublicKey, authority: PublicKey): TransactionInstruction[] {
  const ix: TransactionInstruction[] = [
    createInitializeMetadataPointerInstruction(mint, authority, mint, TOKEN_2022_PROGRAM_ID),
  ];
  switch (p) {
    case "equity":
    case "equity_pause":
    case "equity_scaled":
      // program_id = default pubkey means the slot exists and is EMPTY. That is the state the
      // real mints ship in, and the residual risk we disclose: the authority can point it at a
      // program later, and this program cannot refuse a mint armed after its pool exists.
      ix.push(createInitializeTransferHookInstruction(mint, authority, PublicKey.default, TOKEN_2022_PROGRAM_ID));
      ix.push(createInitializePermanentDelegateInstruction(mint, authority, TOKEN_2022_PROGRAM_ID));
      if (p === "equity_pause")  ix.push(createInitializePausableConfigInstruction(mint, authority, TOKEN_2022_PROGRAM_ID));
      if (p === "equity_scaled") ix.push(createInitializeScaledUiAmountConfigInstruction(mint, authority, 1, TOKEN_2022_PROGRAM_ID));
      break;
    case "trap_fee":
      // 50 bps, capped. Any non-zero config is refused — the gate tests for the extension's
      // presence, not its rate, because a rate is a value the authority can raise later.
      ix.push(createInitializeTransferFeeConfigInstruction(
        mint, authority, authority, 50, BigInt(1_000_000_000), TOKEN_2022_PROGRAM_ID));
      break;
    case "trap_hook":
      ix.push(createInitializeTransferHookInstruction(mint, authority, DUMMY_HOOK_PROGRAM, TOKEN_2022_PROGRAM_ID));
      break;
    case "trap_frozen":
      ix.push(createInitializeDefaultAccountStateInstruction(mint, AccountState.Frozen, TOKEN_2022_PROGRAM_ID));
      break;
  }
  return ix;
}

async function main() {
  const dryRun = hasFlag("dry-run");
  const wantPools = hasFlag("pools");
  const usdcPerPool = Math.round(parseFloat(flagValue("usdc") ?? "2000") * USDC_DEC);
  const only = flagValue("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const selected = only ? FIXTURES.filter((f) => only.includes(f.symbol)) : FIXTURES;
  if (selected.length === 0) throw new Error(`--only matched nothing. Known: ${FIXTURES.map((f) => f.symbol).join(", ")}`);

  const connection = new Connection(serverRpcUrl(), "confirmed");
  const payer = loadKeypair();

  // ── The one guard that matters ────────────────────────────────────────────
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error("REFUSING: this RPC is mainnet-beta. These fixtures have publicly derivable mint authorities and must never exist there.");
  }

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "lib", "soladrome.json"), "utf8"));
  const programId = new PublicKey(idl.address);
  const wallet = new anchor.Wallet(payer);
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" }));
  const [statePda] = PublicKey.findProgramAddressSync([Buffer.from("state")], programId);
  const state: any = await (program.account as any).protocolState.fetch(statePda);
  const usdcMint = state.usdcMint as PublicKey;
  const oSolaMint = state.oSolaMint as PublicKey;

  console.log("── plan ──────────────────────────────────────────────────────");
  console.log("RPC          :", redactRpc(serverRpcUrl()));
  console.log("genesis      :", genesis);
  console.log("payer        :", payer.publicKey.toBase58());
  console.log("program      :", programId.toBase58());
  console.log("mock USDC    :", usdcMint.toBase58());
  console.log("fixtures     :", selected.length, `(${selected.filter((f) => f.admitted).length} admitted, ${selected.filter((f) => !f.admitted).length} refused by design)`);
  console.log("pools        :", wantPools ? `yes, ${(usdcPerPool / USDC_DEC).toLocaleString()} mock USDC per pool` : "no (pass --pools)");
  console.log("lp_enabled   :", state.lpEnabled);
  console.log("──────────────────────────────────────────────────────────────");
  for (const f of selected) {
    const mint = fixtureKeypair(f.symbol).publicKey.toBase58();
    console.log(` ${f.admitted ? "✅" : "⛔"} ${f.symbol.padEnd(8)} ${mint}  ${f.why}`);
  }
  console.log("──────────────────────────────────────────────────────────────");
  if (dryRun) { console.log("\n--dry-run: nothing sent."); return; }
  if (wantPools && !state.lpEnabled) {
    throw new Error("create_pool is closed (lp_enabled = false). Run: npx ts-node scripts/set_phase_flags.ts lp=true");
  }

  // ── 1. the mints ──────────────────────────────────────────────────────────
  const created: Fixture[] = [];
  for (const f of selected) {
    const kp = fixtureKeypair(f.symbol);
    if (await connection.getAccountInfo(kp.publicKey)) {
      console.log(`[mint] ${f.symbol.padEnd(8)} already on chain — skipped`);
      created.push(f);
      continue;
    }

    const metadata: TokenMetadata = {
      mint: kp.publicKey,
      name: `${f.name} (devnet mock)`,
      symbol: f.symbol,
      uri: "",
      additionalMetadata: [["disclaimer", "Devnet test fixture. Not a security, not redeemable, no issuer."]],
    };
    const exts = extensionsFor(f.profile);
    const mintLen = getMintLen(exts);
    // TokenMetadata is variable length, so it is NOT in `getMintLen`: the account is allocated
    // at `mintLen` and the token program reallocs into the extra rent when the metadata
    // initializer runs. Funding both up front is what makes that realloc succeed.
    const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

    // A default-frozen mint needs a freeze authority to exist for the extension to mean
    // anything, so this one fixture gets one. Nothing else does.
    const freezeAuthority = f.profile === "trap_frozen" ? payer.publicKey : null;

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey,
        space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID,
      }),
      ...extensionIxs(f.profile, kp.publicKey, payer.publicKey),
      createInitializeMintInstruction(kp.publicKey, STOCK_DEC, payer.publicKey, freezeAuthority, TOKEN_2022_PROGRAM_ID),
      createInitializeInstruction({
        programId: TOKEN_2022_PROGRAM_ID, mint: kp.publicKey, metadata: kp.publicKey,
        name: metadata.name, symbol: metadata.symbol, uri: metadata.uri,
        mintAuthority: payer.publicKey, updateAuthority: payer.publicKey,
      }),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [payer, kp], { commitment: "confirmed" });
    console.log(`[mint] ${f.symbol.padEnd(8)} ${kp.publicKey.toBase58()}  ${sig.slice(0, 12)}…`);
    created.push(f);
  }

  // ── 2. supply, for the admitted set only ──────────────────────────────────
  //
  // The traps need no balance: they are refused at `create_pool`, which reads the mint and
  // never touches a token account. BADFROZ could not receive a balance anyway — its ATA is
  // born frozen, which is the whole point of it.
  if (wantPools) {
    for (const f of created.filter((x) => x.admitted)) {
      const mint = fixtureKeypair(f.symbol).publicKey;
      const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
      // Twice what the pool takes, so there is something left in the wallet to swap with on camera.
      const want = BigInt(Math.round((usdcPerPool / USDC_DEC / f.demoPrice) * 10 ** STOCK_DEC)) * BigInt(2);
      const pre: TransactionInstruction[] = [];
      if (!(await connection.getAccountInfo(ata))) {
        pre.push(createAssociatedTokenAccountInstruction(
          payer.publicKey, ata, payer.publicKey, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
      }
      const held = (await connection.getAccountInfo(ata))
        ? BigInt((await connection.getTokenAccountBalance(ata)).value.amount) : BigInt(0);
      // Idempotent: top up the shortfall only, so a re-run after a mid-script failure does not
      // mint a second batch.
      const need = want > held ? want - held : BigInt(0);
      if (need > BigInt(0)) {
        pre.push(createMintToInstruction(mint, ata, payer.publicKey, need, [], TOKEN_2022_PROGRAM_ID));
      }
      if (pre.length === 0) { console.log(`[supply] ${f.symbol.padEnd(8)} already funded`); continue; }
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...pre), [payer], { commitment: "confirmed" });
      console.log(`[supply] ${f.symbol.padEnd(8)} ${(Number(want) / 10 ** STOCK_DEC).toFixed(4)} units  ${sig.slice(0, 12)}…`);
    }
  }

  // ── 3. the registry the frontend reads ────────────────────────────────────
  //
  // Built from EVERY fixture that exists on the chain, never from the `--only` subset. Writing
  // `created` here was a real defect: a run with `--only` silently rewrote the registry with
  // just the selected names, so five mints that existed on devnet vanished from the token
  // picker and the pools that used them rendered as truncated addresses. The registry describes
  // the chain, so the chain is what it has to be read from — which also makes this self-healing
  // rather than dependent on the flags of whichever run happened last.
  const onChain: Fixture[] = [];
  for (const f of FIXTURES) {
    if (await connection.getAccountInfo(fixtureKeypair(f.symbol).publicKey)) onChain.push(f);
  }
  const outPath = path.join(__dirname, "..", "app", "lib", "devnet-xstocks.json");
  fs.writeFileSync(outPath, JSON.stringify({
    note: "GENERATED by scripts/mint_devnet_xstocks.ts. Devnet fixtures with publicly derivable mint authorities. Never add these to LAUNCH_TOKENS.",
    cluster: "devnet",
    programId: programId.toBase58(),
    generated: new Date().toISOString(),
    tokens: onChain.map((f) => ({
      symbol: f.symbol,
      name: `${f.name} (devnet mock)`,
      mint: fixtureKeypair(f.symbol).publicKey.toBase58(),
      decimals: STOCK_DEC,
      admitted: f.admitted,
      profile: f.profile,
      why: f.why,
    })),
  }, null, 2) + "\n");
  console.log(`[registry] wrote ${path.relative(path.join(__dirname, ".."), outPath)} — ${onChain.length} of ${FIXTURES.length} fixtures live on chain`);

  if (!wantPools) {
    console.log("\nDone. Pass --pools to create and seed a pool per admitted fixture.");
    return;
  }

  // ── 4. a pool per admitted fixture ────────────────────────────────────────
  const faucet = loadFaucet();
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, payer.publicKey);
  const userOSola = getAssociatedTokenAddressSync(oSolaMint, payer.publicKey);
  const lpDead = SystemProgram.programId; // LP_DEAD_PUBKEY

  const admitted = created.filter((f) => f.admitted);
  // Mint the whole USDC side in one transaction rather than one per pool.
  {
    const pre: TransactionInstruction[] = [];
    if (!(await connection.getAccountInfo(userUsdc))) {
      pre.push(createAssociatedTokenAccountInstruction(payer.publicKey, userUsdc, payer.publicKey, usdcMint));
    }
    const held = (await connection.getAccountInfo(userUsdc))
      ? Number((await connection.getTokenAccountBalance(userUsdc)).value.amount) : 0;
    const need = Math.max(0, usdcPerPool * admitted.length - held);
    if (need > 0) pre.push(createMintToInstruction(usdcMint, userUsdc, faucet.publicKey, need));
    if (pre.length > 0) {
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...pre), [payer, faucet], { commitment: "confirmed" });
      console.log(`[usdc] minted ${(need / USDC_DEC).toLocaleString()} mock USDC  ${sig.slice(0, 12)}…`);
    } else {
      console.log("[usdc] already in hand");
    }
  }

  for (const f of admitted) {
    const stock = fixtureKeypair(f.symbol).publicKey;
    // sort_mints() orders lexicographically on-chain, so (A,B) and (B,A) are one pool.
    const [mintA, mintB] = Buffer.compare(stock.toBuffer(), usdcMint.toBuffer()) <= 0
      ? [stock, usdcMint] : [usdcMint, stock];
    const stockIsA = mintA.equals(stock);
    // This is the pair shape the whole migration exists for: one side Token-2022, one side
    // classic SPL, so the two `token_*_program` accounts genuinely differ.
    const programA = stockIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const programB = stockIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;

    const [pool] = PublicKey.findProgramAddressSync([Buffer.from("amm_pool"), mintA.toBuffer(), mintB.toBuffer()], programId);
    const [lpMint] = PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), pool.toBuffer()], programId);
    const [vaultA] = PublicKey.findProgramAddressSync([Buffer.from("vault_a"), pool.toBuffer()], programId);
    const [vaultB] = PublicKey.findProgramAddressSync([Buffer.from("vault_b"), pool.toBuffer()], programId);
    const [lpUserInfo] = PublicKey.findProgramAddressSync([Buffer.from("lp_user"), pool.toBuffer(), payer.publicKey.toBuffer()], programId);

    if (await (program.account as any).ammPool.fetchNullable(pool)) {
      console.log(`[pool] ${f.symbol.padEnd(8)} exists — skipped`);
      continue;
    }
    const sig = await (program.methods as any)
      .createPool(FEE_RATE_BPS, PROTOCOL_FEE_BPS)
      .accountsPartial({
        creator: payer.publicKey, protocolState: statePda,
        tokenAMint: mintA, tokenBMint: mintB, pool, lpMint,
        tokenAVault: vaultA, tokenBVault: vaultB,
        tokenAProgram: programA, tokenBProgram: programB,
        tokenProgram: TOKEN_PROGRAM_ID, // the LP mint the program creates is always classic SPL
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log(`[pool] ${f.symbol.padEnd(8)} ${pool.toBase58()}  ${sig.slice(0, 12)}…`);

    const userStock = getAssociatedTokenAddressSync(stock, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const userLp = getAssociatedTokenAddressSync(lpMint, payer.publicKey);
    const lpDeadAta = getAssociatedTokenAddressSync(lpMint, lpDead, true);
    const seedPre: TransactionInstruction[] = [];
    for (const [ata, owner] of [[userLp, payer.publicKey], [lpDeadAta, lpDead]] as [PublicKey, PublicKey][]) {
      if (!(await connection.getAccountInfo(ata))) {
        seedPre.push(createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, lpMint));
      }
    }
    const stockBase = new anchor.BN(Math.round((usdcPerPool / USDC_DEC / f.demoPrice) * 10 ** STOCK_DEC));
    const usdcBase = new anchor.BN(usdcPerPool);
    const sig2 = await (program.methods as any)
      .addLiquidity(stockIsA ? stockBase : usdcBase, stockIsA ? usdcBase : stockBase, new anchor.BN(0))
      .accountsPartial({
        user: payer.publicKey, pool, lpMint,
        tokenAMint: mintA, tokenBMint: mintB,
        tokenAVault: vaultA, tokenBVault: vaultB,
        userTokenA: stockIsA ? userStock : userUsdc,
        userTokenB: stockIsA ? userUsdc : userStock,
        userLp, lpDeadAta, lpDead, lpUserInfo,
        protocolState: statePda, oSolaMint, userOSola,
        rent: SYSVAR_RENT_PUBKEY,
        tokenAProgram: programA, tokenBProgram: programB,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(seedPre)
      .rpc();
    console.log(`       seeded ${(usdcPerPool / USDC_DEC).toLocaleString()} USDC @ ~${f.demoPrice}  ${sig2.slice(0, 12)}…`);
  }

  // ── 5. the demonstration: the gate refusing a mint, on a live chain ───────
  //
  // This is the part a reviewer can watch without reading Rust. It is an EXPECTED failure: the
  // script succeeds when the transaction does not.
  const trap = created.find((f) => !f.admitted);
  if (trap) {
    const bad = fixtureKeypair(trap.symbol).publicKey;
    const [mA, mB] = Buffer.compare(bad.toBuffer(), usdcMint.toBuffer()) <= 0 ? [bad, usdcMint] : [usdcMint, bad];
    const badIsA = mA.equals(bad);
    const [p] = PublicKey.findProgramAddressSync([Buffer.from("amm_pool"), mA.toBuffer(), mB.toBuffer()], programId);
    console.log(`\n── the gate, live ────────────────────────────────────────────`);
    console.log(`attempting create_pool on ${trap.symbol} / USDC — ${trap.why}`);
    try {
      await (program.methods as any)
        .createPool(FEE_RATE_BPS, PROTOCOL_FEE_BPS)
        .accountsPartial({
          creator: payer.publicKey, protocolState: statePda,
          tokenAMint: mA, tokenBMint: mB, pool: p,
          lpMint: PublicKey.findProgramAddressSync([Buffer.from("lp_mint"), p.toBuffer()], programId)[0],
          tokenAVault: PublicKey.findProgramAddressSync([Buffer.from("vault_a"), p.toBuffer()], programId)[0],
          tokenBVault: PublicKey.findProgramAddressSync([Buffer.from("vault_b"), p.toBuffer()], programId)[0],
          tokenAProgram: badIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
          tokenBProgram: badIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      console.error("❌ THE POOL WAS CREATED. The admission gate did not fire — stop and investigate.");
      process.exitCode = 1;
    } catch (e: any) {
      const msg = e?.error?.errorMessage ?? e?.message ?? String(e);
      const code = e?.error?.errorCode?.code ?? "";
      console.log(`✅ refused${code ? ` (${code})` : ""}: ${msg.split("\n")[0]}`);
      console.log("   No pool account exists on those seeds, so nothing was left behind to clear.");
    }
    console.log("──────────────────────────────────────────────────────────────");
  }

  console.log("\n⚠️  These pools are NOT approved for emissions, and should not be: the continuous");
  console.log("    rate is PER POOL, so approving seven would multiply total emissions by eight.");
  console.log("⚠️  Close pool creation again when you are done:");
  console.log("    npx ts-node scripts/set_phase_flags.ts lp=false");
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
