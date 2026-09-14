import { LinearClient } from "@linear/sdk";
import type { IssueWriter, LinearCreateIssueArgs } from "@agency-os/shared";

/**
 * The only write-capable Linear client in this codebase. Deliberately kept
 * in its own package, separate from @agency-os/integration-linear (reads)
 * and never depended on by packages/agent — see docs/decisions.md for why
 * this separation, not a runtime check, is the actual safety boundary
 * between "the model's tool loop" and "code that can write to Linear."
 *
 * Takes a write-scoped API key (Linear personal API key, "Create issues"
 * scope, ideally restricted to one team) — never the read-only key used
 * elsewhere in this project.
 */
export class LinearIssueWriter implements IssueWriter {
  private readonly client: LinearClient;

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  async createIssue(args: LinearCreateIssueArgs): Promise<{ issueId: string }> {
    try {
      const payload = await this.client.createIssue({
        teamId: args.teamId,
        projectId: args.projectId,
        title: args.title,
        description: args.description,
        priority: args.priority,
        id: args.id,
      });

      if (!payload.success || !payload.issueId) {
        throw new Error("Linear reported the issue creation as unsuccessful.");
      }

      return { issueId: payload.issueId };
    } catch (err) {
      throw new Error(
        `Linear: failed to create issue: ${(err as Error).message}`,
        {
          cause: err,
        },
      );
    }
  }
}
