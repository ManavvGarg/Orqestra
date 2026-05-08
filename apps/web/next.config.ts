import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@orqestra/trpc", "@orqestra/env"],
  experimental: {
    typedRoutes: true,
  },
};

export default config;
