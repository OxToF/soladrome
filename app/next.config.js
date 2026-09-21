/** @type {import('next').NextConfig} */
const nextConfig = {
  // ☢️ TWO DEV SERVERS MUST NOT SHARE ONE BUILD DIRECTORY.
  //
  // `NEXT_PUBLIC_*` is inlined into the client bundle at COMPILE time, and every `next dev`
  // compiles into `.next`. So running a second dev server with a different
  // `NEXT_PUBLIC_RPC_URL` — a localnet rehearsal beside the devnet app, say — overwrites the
  // first one's chunks with its own endpoint. The first server then keeps serving, on its own
  // port, a bundle that points somewhere else entirely.
  //
  // It is silent and it looks like a protocol outage: `protocolState` reads null, the stats sit
  // as skeletons, the Portfolio shows dashes, and every phase-gated page (Farm, Arb, Vote,
  // Bribe, Claim) disappears from the nav because a null state gates them closed. Set
  // `NEXT_DIST_DIR` on any secondary server and it cannot happen.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // Wormhole Connect v6 (Vite build) hard-codes absolute paths like /main.css.
  // Rewrite to our local copy in /public/wh so the preload succeeds.
  async rewrites() {
    return [
      // Wormhole Connect v6 (Vite) hardcodes absolute paths from root.
      // Rewrite them to our local copy in /public/wh/.
      { source: "/main.css",        destination: "/wh/main.css"        },
      { source: "/assets/:path*",   destination: "/wh/assets/:path*"   },
      // Clean URL for the bribe-bridge satellite page (vercel cleanUrls is ignored
      // under the Next.js framework preset — must rewrite here).
      { source: "/bribebridge",     destination: "/bribebridge.html"   },
    ];
  },
  webpack: (config, { isServer }) => {
    config.resolve.fallback = {
      fs: false, path: false, os: false,
      net: false, tls: false, crypto: false,
    };
    // silence pino-pretty optional peer dep warning
    config.resolve.alias = {
      ...config.resolve.alias,
      "pino-pretty": false,
      // sui-snap-wallet ships raw TS source with template literal types that
      // Webpack can't parse. Point to the compiled dist instead.
      "@kunalabs-io/sui-snap-wallet": require.resolve("@kunalabs-io/sui-snap-wallet"),
    };
    return config;
  },
};
module.exports = nextConfig;
