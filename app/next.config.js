/** @type {import('next').NextConfig} */
const nextConfig = {
  // @kunalabs-io/sui-snap-wallet ships TS source with template literal types
  // that Webpack's SWC loader rejects — transpile the package via Next.js
  transpilePackages: ["@kunalabs-io/sui-snap-wallet"],
  // Wormhole Connect v6 (Vite build) hard-codes absolute paths like /main.css.
  // Rewrite to our local copy in /public/wh so the preload succeeds.
  async rewrites() {
    return [
      // Wormhole Connect v6 (Vite) hardcodes absolute paths from root.
      // Rewrite them to our local copy in /public/wh/.
      { source: "/main.css",        destination: "/wh/main.css"        },
      { source: "/assets/:path*",   destination: "/wh/assets/:path*"   },
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
    };
    return config;
  },
};
module.exports = nextConfig;
