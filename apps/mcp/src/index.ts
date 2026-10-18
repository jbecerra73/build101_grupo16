// FrictionSwarm MCP server for Claude Code (stdio). A thin client of the dashboard API:
//   claude mcp add frictionswarm -e FS_API_URL=... -e FS_API_TOKEN=... -- npx tsx apps/mcp/src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./client";
import { registerTools } from "./tools";

const baseUrl = (process.env.FS_API_URL || "http://localhost:3000").replace(/\/+$/, "");
const api = new ApiClient({ baseUrl, token: process.env.FS_API_TOKEN });
const server = new McpServer({ name: "frictionswarm", version: "0.1.0" });
registerTools(server, api, { dashboard: (path) => `${baseUrl}${path}` });
await server.connect(new StdioServerTransport());
