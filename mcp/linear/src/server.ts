import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LinearIssueTracker } from "@agency-os/integration-linear";
import { registerLinearTools } from "./tools.js";

// No dotenv loading here: the client that spawns this process (see
// packages/integrations/linear-mcp-client) injects LINEAR_API_KEY directly
// into the child's environment. Running this file standalone requires the
// variable to already be exported in the shell.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const issueTracker = new LinearIssueTracker(requireEnv("LINEAR_API_KEY"));

const server = new McpServer({ name: "agency-os-linear", version: "0.1.0" });
registerLinearTools(server, issueTracker);

await server.connect(new StdioServerTransport());
