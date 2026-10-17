import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // LAN preview: without this, blocked HMR websockets make the tab full-reload.
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? "localhost,127.0.0.1").split(",").map((value) => value.trim()).filter(Boolean),
  // MP3 cache lives in ./data. Watching it makes Fast Refresh reload the tab
  // whenever extract writes a file. Dev is started with --webpack so this applies.
  webpack: (config) => {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ["**/.git/**", "**/node_modules/**", "**/data/**"],
    };
    return config;
  },
};

export default nextConfig;
