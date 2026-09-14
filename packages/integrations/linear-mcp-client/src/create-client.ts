import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const DEFAULT_SERVER_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../mcp/linear/src/server.ts",
);

export interface CreateLinearMcpClientOptions {
  linearApiKey: string;
  /** Override for tests/alternate layouts; defaults to mcp/linear/src/server.ts in this repo. */
  serverEntryPath?: string;
}

/**
 * Spawns the custom Linear MCP server as a child process over stdio and
 * returns a connected client. The transport's default environment is a
 * fixed safe allowlist (PATH, HOME, etc.) that does NOT include arbitrary
 * env vars — LINEAR_API_KEY must be injected explicitly, which is the
 * authentication boundary: the key never leaves this process except into
 * its own child.
 *
 * Call `.close()` on the returned client when done, to terminate the child
 * process.
 */
export async function createLinearMcpClient(
  options: CreateLinearMcpClientOptions,
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", options.serverEntryPath ?? DEFAULT_SERVER_ENTRY],
    env: {
      ...getDefaultEnvironment(),
      LINEAR_API_KEY: options.linearApiKey,
    },
  });

  const client = new Client({ name: "agency-os-agent", version: "0.1.0" });
  await client.connect(transport);
  return client;
}
