// Run with, from `app/`:
//   node --import ./scripts/json-loader.mjs --test lib/sendtx.test.mts
//
// ⚠️ NODE 24, unlike the sibling test files. This one reaches `lib/program.ts`, which imports
// `BN` from the CommonJS `@coral-xyz/anchor`; Node 22 refuses the named export and the run dies
// on a SyntaxError before a single test executes. Same cause and same fix as the bankrun suites.
// The loader is what teaches Node to read the IDL as JSON without an import attribute.
//
// ☢️ WHY A FAKE RPC AND NOT A MOCK OBJECT. `sendTx` builds its OWN `Connection` from the
// endpoint of the one it is handed — deliberately, so the send path bypasses the global read
// throttle — so there is no seam to inject a double into. The only way to drive it is to be the
// server. That also means these tests exercise the real web3.js client, blockhash handling and
// all, rather than a hand-written idea of it.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Connection, Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { sendTx } from "./program.ts";

const BLOCKHASH = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type Script = {
  /// Block heights handed out in order; the last one repeats.
  heights: number[];
  /// Status returned for a signature, in call order. ⚠️ `slot` and `confirmations` are not
  /// decoration: web3.js validates the response with superstruct and THROWS on a missing field,
  /// which surfaces as an unrelated failure several steps later.
  statuses: (null | { err: unknown | null; confirmationStatus?: string; slot: number; confirmations: number | null })[];
};

/// A JSON-RPC server that answers only what `sendTx` asks, and lies about heights on a script.
function fakeRpc(script: Script): Promise<{ url: string; close: () => Promise<void>; sent: string[] }> {
  const sent: string[] = [];
  let heightCall = 0;
  let statusCall = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = JSON.parse(body);
      const one = (r: any) => {
        const ctx = { apiVersion: "2.0.0", slot: 1 };
        switch (r.method) {
          case "getBalance":
            return { context: ctx, value: 1_000_000_000 };
          case "getLatestBlockhash":
            return { context: ctx, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
          case "getBlockHeight": {
            const h = script.heights[Math.min(heightCall, script.heights.length - 1)];
            heightCall++;
            return h;
          }
          case "sendTransaction": {
            const sig = `SIG${sent.length}${"1".repeat(60)}`;
            sent.push(sig);
            return sig;
          }
          case "getSignatureStatuses": {
            const s = script.statuses[Math.min(statusCall, script.statuses.length - 1)];
            statusCall++;
            return { context: ctx, value: [s] };
          }
          default:
            return null;
        }
      };
      const out = Array.isArray(reqs)
        ? reqs.map((r) => ({ jsonrpc: "2.0", id: r.id, result: one(r) }))
        : { jsonrpc: "2.0", id: reqs.id, result: one(reqs) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        sent,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/// A wallet and an instruction that wants exactly its signature.
///
/// ⚠️ The two must be built together: `serialize()` verifies that every required signer has
/// signed, so an instruction naming any other account as its source throws before a single byte
/// reaches the server — and the failure surfaces as a hung test, not a clear one, because the
/// server is then never closed.
function walletAndIx() {
  const kp = Keypair.generate();
  return {
    wallet: {
      publicKey: kp.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.sign(kp);
        return tx;
      },
    },
    ixs: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 })],
  };
}

test("the happy path returns the signature", async () => {
  const rpc = await fakeRpc({
    heights: [1, 1],
    statuses: [{ err: null, confirmationStatus: "confirmed", slot: 1, confirmations: null }],
  });
  const { wallet, ixs } = walletAndIx();
  try {
    const sig = await sendTx(new Connection(rpc.url), wallet as any, ixs);
    assert.match(sig, /^SIG0/);
  } finally {
    await rpc.close();
  }
});

// ☢️ The bug this file exists for. The countdown starts when the blockhash is fetched, NOT when
// the wallet finally returns, so a signature that takes longer than the window travels with a
// blockhash no validator will accept. Measured at 25.4s on devnet, not the 60s the 400ms slot
// time implies.
test("a blockhash that died while the wallet was open is not even sent", async () => {
  const rpc = await fakeRpc({
    // First height read (the pre-send check) is already past lastValidBlockHeight=100.
    // Second attempt is in time and confirms.
    heights: [101, 1, 1],
    statuses: [{ err: null, confirmationStatus: "confirmed", slot: 1, confirmations: null }],
  });
  const { wallet, ixs } = walletAndIx();
  try {
    const sig = await sendTx(new Connection(rpc.url), wallet as any, ixs);
    assert.equal(rpc.sent.length, 1, "the dead transaction must never be broadcast");
    assert.match(sig, /^SIG0/, "the signature returned is the second attempt's");
  } finally {
    await rpc.close();
  }
});

// ☢️ THE SAFETY PROPERTY. A retry re-signs the same instructions, so an attempt that actually
// LANDED and was merely missed by the polling must never be retried — that would compound twice,
// or arm twice. Past lastValidBlockHeight the old blockhash can no longer be accepted, so the
// final status read is conclusive.
test("an attempt that landed but was missed is returned, never retried", async () => {
  const rpc = await fakeRpc({
    heights: [1, 101],
    statuses: [
      null, // in-loop poll: nothing yet
      { err: null, confirmationStatus: "confirmed", slot: 1, confirmations: null }, // conclusive read
    ],
  });
  const { wallet, ixs } = walletAndIx();
  try {
    const sig = await sendTx(new Connection(rpc.url), wallet as any, ixs);
    assert.equal(rpc.sent.length, 1, "no second signature may ever be requested");
    assert.match(sig, /^SIG0/);
  } finally {
    await rpc.close();
  }
});

test("two expired attempts fail with the reason, and it is not congestion", async () => {
  const rpc = await fakeRpc({ heights: [101], statuses: [null] });
  const { wallet, ixs } = walletAndIx();
  try {
    await assert.rejects(
      () => sendTx(new Connection(rpc.url), wallet as any, ixs),
      (e: Error) => {
        assert.match(e.message, /expired while it was waiting to be signed/);
        assert.doesNotMatch(e.message, /congest/i, "the old message blamed a healthy network");
        return true;
      },
    );
  } finally {
    await rpc.close();
  }
});
