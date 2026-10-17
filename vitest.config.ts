import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dashboard = fileURLToPath(new URL("./apps/dashboard/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Dashboard modules are server-only and use the "@/" path alias.
      { find: /^server-only$/, replacement: `${dashboard}test/server-only.ts` },
      { find: /^@\//, replacement: dashboard },
    ],
  },
  test: {
    exclude: ["**/node_modules/**", "**/.next/**", "**/.netlify/**"],
  },
});
