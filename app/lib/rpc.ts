// The default every caller falls back to. Public devnet RPC: slow and prone to
// timeouts, but always reachable, which is the point of a fallback.
export const FALLBACK_RPC_URL = "https://api.devnet.solana.com";

// A truncated copy-paste is the failure this file exists for, and U+2026 is its
// signature: a UI rendered "…" to elide the value and the ellipsis came along
// with the clipboard. It is never legitimate inside a URL.
const ELLIPSIS = "…";

/**
 * Return the first candidate that is actually usable as an RPC endpoint,
 * falling back to public devnet.
 *
 * `??` and `||` guard against *missing* — they hand a defined-but-malformed
 * value straight to `new Connection()`, which throws "Endpoint URL must start
 * with `http:` or `https:`" at the first call. So the variable meant to improve
 * the endpoint is what disarms the fallback protecting it.
 *
 * Not hypothetical: on 2026-08-13 `FAUCET_RPC_URL` was set in Vercel to
 * "ttps://devnet.helius-rpc.com/?api-key=3a3…", copy-pasted from the
 * dashboard's own truncated display — leading `h` lost, key cut short. The
 * faucet was dead in production for three days while it worked locally, and the
 * web3.js error surfaced verbatim under the Buy button.
 *
 * Rejection is loud on purpose: a bad endpoint that silently degrades to the
 * public RPC looks like "the RPC is flaky today" for as long as nobody reads
 * the logs.
 */
export function resolveRpcUrl(...candidates: (string | undefined)[]): string {
  for (const raw of candidates) {
    const url = raw?.trim();
    if (!url) continue;
    if (isUsableRpcUrl(url)) return url;
    console.warn(`[rpc] ignoring malformed endpoint ${redact(url)} — falling back`);
  }
  return FALLBACK_RPC_URL;
}

/**
 * Catches the two halves of the 2026-08-13 breakage: a protocol `Connection`
 * refuses, and the ellipsis left by a truncated copy. It does NOT catch a key
 * that is merely *wrong* — a well-formed URL with a bad api-key still parses,
 * and only the RPC itself can reject it.
 */
export function isUsableRpcUrl(url: string): boolean {
  if (url.includes(ELLIPSIS)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Endpoints carry api keys in the query string; the warning has to name the bad
// value without printing the good part of a credential into the logs.
function redact(url: string): string {
  const head = url.slice(0, 24);
  return url.length > head.length ? `${head}…` : head;
}
