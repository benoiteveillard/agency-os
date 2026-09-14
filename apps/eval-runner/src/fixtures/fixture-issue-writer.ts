import type { IssueWriter, LinearCreateIssueArgs } from "@agency-os/shared";
import type { FixtureOutcome } from "./types.js";

export interface IssueWriterFixtureConfig {
  createIssue: FixtureOutcome<{ issueId: string }>;
}

export class FixtureIssueWriter implements IssueWriter {
  constructor(private readonly config: IssueWriterFixtureConfig) {}

  async createIssue(
    _args: LinearCreateIssueArgs,
  ): Promise<{ issueId: string }> {
    const outcome = this.config.createIssue;
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  }
}
