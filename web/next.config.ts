import path from "node:path";
import type { NextConfig } from "next";

const root = path.resolve(process.cwd());

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  outputFileTracingRoot: root,
  turbopack: { root },
};

export default nextConfig;
