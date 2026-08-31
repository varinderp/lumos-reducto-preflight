import type { NextConfig } from "next";

const basePath = (process.env.NEXT_PUBLIC_LUMOS_BASE_PATH ?? "")
  .trim()
  .replace(/\/+$/, "");

if (basePath && !basePath.startsWith("/")) {
  throw new Error("NEXT_PUBLIC_LUMOS_BASE_PATH must start with '/'.");
}

const nextConfig: NextConfig = {
  basePath,
  assetPrefix: basePath || undefined,
  images: basePath ? { unoptimized: true } : undefined,
  output: process.env.LUMOS_DEPLOY_TARGET === "replit" ? "standalone" : undefined,
};

export default nextConfig;
