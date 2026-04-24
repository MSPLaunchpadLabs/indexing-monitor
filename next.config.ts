import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The legacy Python `api/` folder and the vanilla-JS `dashboard/` folder are
  // archived via .vercelignore and excluded from tsconfig, so Next.js doesn't
  // try to pick them up during the build.
};

export default config;
