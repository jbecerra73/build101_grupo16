import type { NextConfig } from "next";

// Queue-mode builds (always on Netlify): the dashboard only enqueues runs and
// an external orchestrator (`npm run orchestrator`, locally or in a tenki
// sandbox) takes them, so the pipeline is replaced by a stub and stays out of
// the function bundle. See docs/DEPLOY.md.
const onNetlify = process.env.NETLIFY === "true";
const queueBuild = onNetlify || process.env.ORCHESTRATOR === "queue" || process.env.ORCHESTRATOR === "daemon";

// Paths are relative to this folder (apps/dashboard); the trace root is the repo.
const neverShip = [
  "../../data/**", // PostHog dataset (~220 MB, generated)
  "../../tools/**", // posthog-sim
  "../../worker/**", // P2's browser agents
  "../../packages/pipeline/**",
  "../../packages/analyzer/**",
  "../../runs/!(fixture-*)/**", // live runs; the dashboard reads them from the store
  "../../runs/.control/**",
  "../../.orchestrator-work/**",
  "./scripts/**", // screenshot tooling and the offline swarm's shots
  "../../node_modules/playwright/**",
  "../../node_modules/playwright-core/**",
  "../../node_modules/@anthropic-ai/**",
  "../../node_modules/@tenkicloud/**",
  "../../node_modules/@modelcontextprotocol/**",
];

// Run data is read live from the store on every request (see lib/runs.ts), so
// we keep the classic dynamic-by-request model rather than Cache Components.
const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources; the pipeline also pulls in
  // ../../orchestrator via relative imports and the analyzer lazily.
  transpilePackages: ["@frictionswarm/shared", "@frictionswarm/pipeline", "@frictionswarm/analyzer", "@frictionswarm/store", "@frictionswarm/posthog"],
  // The Agent SDK spawns its bundled Claude Code CLI from its own package
  // folder, and the sandbox client is plain Node: load them from node_modules.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/sdk", "@tenkicloud/sandbox"],
  // Baked into every bundle, the proxy included (lib/deploy.ts): Netlify's
  // [build.environment] does not reach the functions at runtime.
  env: {
    FS_BUILD_NETLIFY: onNetlify ? "1" : "",
    FS_BUILD_REQUIRE_PASSWORD: onNetlify || process.env.DASHBOARD_REQUIRE_PASSWORD === "1" ? "1" : "",
    FS_BUILD_RUN_STORE: process.env.RUN_STORE ?? (onNetlify ? "blobs" : ""),
    FS_BUILD_ORCHESTRATOR: queueBuild ? "queue" : "",
  },
  // The committed demo runs back the Blobs store as a read-only layer (lib/store.ts).
  outputFileTracingIncludes: { "/**": ["../../runs/fixture-*/**"] },
  outputFileTracingExcludes: queueBuild ? { "/**": neverShip } : {},
  // The dashboard is demoed from `next dev`; the floating "N" badge covers the agent grid.
  devIndicators: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
    ...(queueBuild ? { resolveAlias: { "@frictionswarm/pipeline": "./lib/pipeline-stub.ts" } } : {}),
  },
};

export default nextConfig;
