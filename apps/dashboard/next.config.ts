import type { NextConfig } from "next";

// Run data is read live from disk on every request (see lib/runs.ts), so we
// keep the classic dynamic-by-request model rather than Cache Components.
const nextConfig: NextConfig = {
  transpilePackages: ["@frictionswarm/shared"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
