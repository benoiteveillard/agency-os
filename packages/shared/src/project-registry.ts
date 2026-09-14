/**
 * Deterministic mapping from an internal project slug to the external systems
 * that hold its data. Linear and GitHub have no inherent link between them,
 * so this mapping is intentionally explicit and static rather than
 * discovered dynamically.
 *
 * Extend this object when a new project is onboarded. Do not build a dynamic
 * registry service until there is a concrete reason to (AGENTS.md #42).
 */
export interface ProjectRegistryEntry {
  displayName: string;
  linearProjectId: string;
  githubOwner: string;
  githubRepo: string;
  slackChannelId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return value;
}

/**
 * Lazily built so importing this module never throws at load time (useful
 * for tests); the required env var is only read when a registry is actually
 * requested.
 */
export function loadProjectRegistry(): Record<string, ProjectRegistryEntry> {
  return {
    "acme-website-migration": {
      displayName: "Acme Website Migration",
      linearProjectId: requireEnv("LINEAR_PROJECT_ID_ACME"),
      githubOwner: "os-agency-fake",
      githubRepo: "acme-website-migration",
      slackChannelId: requireEnv("SLACK_CHANNEL_ID_ACME"),
    },
  };
}
