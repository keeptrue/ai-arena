import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Runtime files (sqlite db, secrets, game defs) are read from disk at request time.
  serverExternalPackages: [],
  // Dev-only: allow opening the app via 127.0.0.1 as well as localhost, otherwise
  // Next blocks the client runtime as a cross-origin dev resource and pages never hydrate.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
