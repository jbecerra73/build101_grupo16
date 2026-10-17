import type { NextConfig } from "next";

// Run data is read live from disk on every request (see lib/runs.ts), so we
// keep the classic dynamic-by-request model rather than Cache Components.
const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources; the pipeline also pulls in
  // ../../orchestrator via relative imports and the analyzer lazily.
  transpilePackages: ["@frictionswarm/shared", "@frictionswarm/pipeline", "@frictionswarm/analyzer", "@frictionswarm/store"],
  // The Agent SDK spawns its bundled Claude Code CLI from its own package
  // folder, and the sandbox client is plain Node: load them from node_modules.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@tenkicloud/sandbox"],
  // The dashboard is demoed from `next dev`; the floating "N" badge covers the agent grid.
  devIndicators: false,
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
