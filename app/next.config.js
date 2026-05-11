/** @type {import('next').NextConfig} */
const nextConfig = {
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
