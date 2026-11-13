import type {
  IssueTracker,
  ProjectIssue,
  ProjectIssuesResult,
} from "@agency-os/integration-linear";
import type { FixtureOutcome } from "./types.js";

export interface LinearFixtureConfig {
  /** `truncated` defaults to false, so fixtures only state it when they test it. */
  listProjectIssues: FixtureOutcome<
    Omit<ProjectIssuesResult, "truncated"> & { truncated?: boolean }
  >;
  /** Absent unless the scenario exercises the post-write read-back path. */
  getIssue?: FixtureOutcome<ProjectIssue>;
}

export class FixtureIssueTracker implements IssueTracker {
  constructor(private readonly config: LinearFixtureConfig) {}

  async listProjectIssues(_projectId: string): Promise<ProjectIssuesResult> {
    const outcome = this.config.listProjectIssues;
    if (!outcome.ok) throw new Error(outcome.error);
    return { truncated: false, ...outcome.value };
  }

  async getIssue(idOrIdentifier: string): Promise<ProjectIssue> {
    const outcome = this.config.getIssue;
    if (!outcome) {
      throw new Error(
        `Fixture misconfigured: no getIssue outcome configured for "${idOrIdentifier}"`,
      );
    }
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.value;
  }
}
