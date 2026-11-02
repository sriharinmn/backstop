import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  // PGlite ships a WASM build that must not be bundled.
  serverExternalPackages: ['@electric-sql/pglite'],
};

export default nextConfig;
