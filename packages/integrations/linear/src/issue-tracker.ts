import { LinearClient, type Issue, type IssueRelation } from "@linear/sdk";
import { isOverdue } from "./overdue.js";

/** Resolves a set of relation records to the referenced issue's identity fields. */
async function resolveRelated(
  relations: IssueRelation[],
  pick: (relation: IssueRelation) => Promise<Issue> | undefined,
): Promise<RelatedIssueRef[]> {
  const resolved = await Promise.all(
    relations.map((relation) => pick(relation) ?? Promise.resolve(undefined)),
  );
  return resolved
    .filter((issue): issue is Issue => Boolean(issue))
    .map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    }));
}

export interface RelatedIssueRef {
  id: string;
  identifier: string;
  title: string;
}

export interface ProjectIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  priorityLabel: string;
  dueDate: string | null;
  overdue: boolean;
  updatedAt: string;
  /** Issues this one must wait on (explicit Linear `blocks` relation, incoming). */
  blockedBy: RelatedIssueRef[];
  /** Issues this one is holding up (explicit Linear `blocks` relation, outgoing). */
  blocks: RelatedIssueRef[];
}

export interface ProjectSummary {
  id: string;
  name: string;
  url: string;
  targetDate: string | null;
  /** Linear's own health signal for the project: "onTrack" | "atRisk" | "offTrack", if set. */
  health: string | null;
}

export interface ProjectIssuesResult {
  project: ProjectSummary;
  issues: ProjectIssue[];
}

/**
 * Read-only port for issue-tracker data. LinearIssueTracker is the only
 * implementation today; the interface exists so agent/tool code doesn't
 * depend on @linear/sdk's response shapes directly (AGENTS.md #11).
 */
export interface IssueTracker {
  listProjectIssues(projectId: string): Promise<ProjectIssuesResult>;
}

const PAGE_SIZE = 50;
// Safety cap on pagination. Synthetic demo projects are small (tens of
// issues); this exists to bound worst-case latency/cost, not to handle real
// production volume.
const MAX_PAGES = 10;

export class LinearIssueTracker implements IssueTracker {
  private readonly client: LinearClient;

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey });
  }

  async listProjectIssues(projectId: string): Promise<ProjectIssuesResult> {
    try {
      const project = await this.client.project(projectId);

      let connection = await project.issues({ first: PAGE_SIZE });
      let pagesFetched = 1;
      while (connection.pageInfo.hasNextPage && pagesFetched < MAX_PAGES) {
        connection = await connection.fetchNext();
        pagesFetched += 1;
      }

      const issues = await Promise.all(
        connection.nodes.map((issue) => this.resolveIssue(issue)),
      );

      return {
        project: {
          id: project.id,
          name: project.name,
          url: project.url,
          targetDate: project.targetDate ?? null,
          health: project.health ?? null,
        },
        issues,
      };
    } catch (err) {
      throw new Error(
        `Linear: failed to load project "${projectId}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  private async resolveIssue(issue: Issue): Promise<ProjectIssue> {
    const [state, relations, inverseRelations] = await Promise.all([
      issue.state,
      issue.relations(),
      issue.inverseRelations(),
    ]);

    // relations(): this issue is the relation's source. type "blocks" means
    // this issue blocks relation.relatedIssue.
    const blocks = await resolveRelated(
      relations.nodes.filter((relation) => relation.type === "blocks"),
      (relation) => relation.relatedIssue,
    );

    // inverseRelations(): this issue is the relation's target. type "blocks"
    // means relation.issue (the source) blocks this issue.
    const blockedBy = await resolveRelated(
      inverseRelations.nodes.filter((relation) => relation.type === "blocks"),
      (relation) => relation.issue,
    );

    const dueDate = issue.dueDate ?? null;
    const stateType = state?.type ?? "unknown";

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: state?.name ?? "unknown",
      stateType,
      priorityLabel: issue.priorityLabel,
      dueDate,
      overdue: isOverdue(dueDate, stateType),
      updatedAt: issue.updatedAt.toISOString(),
      blockedBy,
      blocks,
    };
  }
}
