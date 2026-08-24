// SPDX-License-Identifier: BUSL-1.1
// Copyright (C) 2025 Soladrome Labs
//
// Checks `app/lib/tokens.ts` against mainnet. Adapted from the Solana
// Foundation's `scripts/check-well-known-mints.mjs`
// (solana-foundation/solana-developer-platform, MIT).
//
// WHY THIS EXISTS: `LAUNCH_TOKENS` carries a comment — "Decimals verified
// against mainnet 2026-07-24" — and `TRUSTED_MINTS` carries another —
// "classic SPL, Token-2022 excluded". Both are load-bearing and neither is
// enforced by anything. Three properties are unsafe to hold on trust:
//
//   1. the address is a mint at all (a typo lands on a wallet or a token
//      account, and only the address distinguishes a spoof from the real
//      asset — name and symbol are free to copy)
//   2. `decimals` matches the mint. The points snapshot job reads decimals
//      on-chain, but the Pools and Points UI reads them from this file, so a
//      wrong value misscales every amount shown for that token by 10^n
//   3. the owning program is classic SPL Token. This is the one the comment
//      cannot enforce: the AMM's `Account<Mint>` / `Program<Token>`
//      constraints reject Token-2022, so a Token-2022 mint reaching
//      `LAUNCH_TOKENS` produces a token the UI offers and `create_pool`
//      refuses — a launch-day failure with no local repro, since devnet
//      carries none of these mints.
//
// Deliberately NOT wired into CI, for the same reason the SDP original isn't:
// it needs a live mainnet RPC, and a rate-limited endpoint would make the
// pipeline flaky for no safety gain. Run it by hand whenever a registry entry
// is added or changed — that is the moment the three properties can go wrong.
//
// Divergence from the SDP original, which walks entries one at a time behind a
// 120 ms spacer: this batches through `getMultipleAccounts` (100 per call, the
// RPC cap). Serial per-address reads are exactly the pattern that produced the
// Helius 429 storms in the frontend, and the fix there was the same one.
//
// Usage (from the repo root):
//   TS_NODE_TRANSPILE_ONLY=1 TS_NODE_COMPILER_OPTIONS='{"resolveJsonModule":true}' \
//     yarn ts-node scripts/check_token_registry.ts
//   # override the endpoint when the public RPC throttles:
//   MAINNET_RPC_URL=https://... yarn ts-node scripts/check_token_registry.ts

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { LAUNCH_TOKENS, TRUSTED_MINTS, TRUSTED_DECIMALS, WSOL_MINT } from "../app/lib/tokens";
import { solaM, oSolaM, hiSolaM } from "../app/lib/program";

const RPC_URL = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";

// `getMultipleAccounts` caps at 100 addresses per call.
const BATCH_SIZE = 100;

// Program-derived and protocol-local mints. They live on whichever cluster the
// program is deployed to, never on mainnet while the protocol is pre-launch, so
// asserting their existence here would fail for the wrong reason. Reported
// separately instead of checked.
const PROTOCOL_MINTS = new Map<string, string>([
  [solaM.toString(), "SOLA (PDA)"],
  [oSolaM.toString(), "oSOLA (PDA)"],
  [hiSolaM.toString(), "hiSOLA (legacy mint — hiSOLA is a position since 2026-08-21)"],
]);

interface Expectation {
  /** What to call this entry in the report. */
  label: string;
  decimals?: number;
  /**
   * True when `decimals` is the `?? 6` fallback rather than a declared value.
   * A mismatch then means "add it to TRUSTED_DECIMALS", not "the declaration is
   * wrong", and the report has to say which.
   */
  inferredScale?: boolean;
}

/** jsonParsed shape of a mint account, narrowed to the fields checked here. */
interface ParsedMintAccount {
  owner: PublicKey;
  data: { parsed?: { type?: string; info?: { decimals?: number } } };
}

function buildExpectations(): Map<string, Expectation> {
  const expectations = new Map<string, Expectation>();

  // wSOL is asserted explicitly: `getTokenList` hardcodes it at 9 decimals and
  // every SOL-side pool amount in the UI is scaled by that number.
  expectations.set(WSOL_MINT, { label: "wSOL", decimals: 9 });

  for (const token of LAUNCH_TOKENS) {
    expectations.set(token.mint, { label: `${token.symbol} (LAUNCH_TOKENS)`, decimals: token.decimals });
  }

  // `TRUSTED_MINTS` only gates which pools the UI displays, so a wrong entry
  // does not misscale anything by itself — but a non-mint address there is
  // still a typo, and `decimalsForMint` falls back to 6 for anything absent
  // from both `LAUNCH_TOKENS` and `TRUSTED_DECIMALS`. So the scale a
  // trusted-only entry is *effectively* declared at is `TRUSTED_DECIMALS[mint]
  // ?? 6`, and that is what gets asserted: a 9-decimal partner mint listed only
  // in `TRUSTED_MINTS` fails here rather than displaying 1000x its real size
  // the day a pool opens for it.
  for (const mint of TRUSTED_MINTS) {
    if (PROTOCOL_MINTS.has(mint)) continue;
    if (expectations.has(mint)) continue;
    expectations.set(mint, {
      label: `${mint.slice(0, 8)}… (TRUSTED_MINTS)`,
      decimals: TRUSTED_DECIMALS[mint] ?? 6,
      inferredScale: TRUSTED_DECIMALS[mint] === undefined,
    });
  }

  return expectations;
}

function findProblems(account: ParsedMintAccount | null, expected: Expectation): string[] {
  if (!account) return ["no account exists at this address"];

  const problems: string[] = [];

  const parsedType = account.data?.parsed?.type;
  if (parsedType !== "mint") {
    problems.push(`account is a "${parsedType ?? "unparseable"}", not a mint`);
  }

  const onChainDecimals = account.data?.parsed?.info?.decimals;
  if (expected.decimals !== undefined && onChainDecimals !== expected.decimals) {
    problems.push(
      expected.inferredScale
        ? `chain says ${onChainDecimals} decimals, but decimalsForMint falls back to ${expected.decimals} — add it to TRUSTED_DECIMALS`
        : `declared decimals ${expected.decimals}, chain says ${onChainDecimals}`
    );
  }

  const owner = account.owner.toString();
  if (owner === TOKEN_2022_PROGRAM_ID.toString()) {
    problems.push("Token-2022 mint — the AMM's Program<Token> constraint rejects it, create_pool cannot succeed");
  } else if (owner !== TOKEN_PROGRAM_ID.toString()) {
    problems.push(`owned by ${owner}, not the SPL Token program`);
  }

  return problems;
}

async function main(): Promise<void> {
  const expectations = buildExpectations();
  const addresses = [...expectations.keys()];
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`Checking ${addresses.length} registry entries against ${new URL(RPC_URL).hostname}\n`);

  const accounts: (ParsedMintAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE).map((a) => new PublicKey(a));
    const infos = await connection.getMultipleParsedAccounts(batch);
    accounts.push(...(infos.value as (ParsedMintAccount | null)[]));
  }

  const failures: string[] = [];
  let verified = 0;

  addresses.forEach((address, i) => {
    const expected = expectations.get(address)!;
    const problems = findProblems(accounts[i], expected);

    if (problems.length > 0) {
      const failure = `${expected.label} [${address}]: ${problems.join("; ")}`;
      failures.push(failure);
      console.error(`FAIL  ${failure}`);
    } else {
      verified += 1;
      const decimals = accounts[i]!.data.parsed!.info!.decimals;
      console.log(`ok    ${expected.label} — ${decimals} decimals, spl-token`);
    }
  });

  console.log("\nProtocol mints, not checked (program-derived, absent from mainnet pre-launch):");
  for (const [address, label] of PROTOCOL_MINTS) {
    console.log(`skip  ${label} [${address}]`);
  }

  console.log(`\n${verified} verified, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
