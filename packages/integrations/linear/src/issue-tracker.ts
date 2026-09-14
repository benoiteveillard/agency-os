import { LinearClient, type Issue } from "@linear/sdk";
import { isOverdue } from "./overdue.js";

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
 * Read-only port for issue-tracker data. LinearIssueTracker (direct
 * @linear/sdk) and McpLinearIssueTracker (via the custom Linear MCP server,
 * see mcp/linear) both implement this; agent/tool code depends on neither
 * directly (AGENTS.md #11).
 */
export interface IssueTracker {
  listProjectIssues(projectId: string): Promise<ProjectIssuesResult>;
  getIssue(idOrIdentifier: string): Promise<ProjectIssue>;
}

// --- Minimal shapes resolveProjectIssue actually reads off a Linear issue.
// Real @linear/sdk `Issue`/`IssueRelation` instances satisfy these
// structurally (their public getters match), but typing against these
// narrow interfaces — rather than the concrete SDK classes, which carry
// private fields and so can't be satisfied by a hand-built object — is what
// makes resolveProjectIssue unit-testable without constructing real SDK
// model instances. See issue-tracker.test.ts.

interface IssueRefLike {
  id: string;
  identifier: string;
  title: string;
}

interface RelationLike {
  type: string;
  issue: Promise<IssueRefLike | undefined> | undefined;
  relatedIssue: Promise<IssueRefLike | undefined> | undefined;
}

interface WorkflowStateLike {
  name: string;
  type: string;
}

export interface IssueLike {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priorityLabel: string;
  dueDate?: string | null;
  updatedAt: Date;
  state: Promise<WorkflowStateLike | undefined> | undefined;
  relations(): Promise<{ nodes: RelationLike[] }>;
  inverseRelations(): Promise<{ nodes: RelationLike[] }>;
}

/** Resolves a set of relation records to the referenced issue's identity fields. */
async function resolveRelated(
  relations: RelationLike[],
  pick: (
    relation: RelationLike,
  ) => Promise<IssueRefLike | undefined> | undefined,
): Promise<RelatedIssueRef[]> {
  const resolved = await Promise.all(
    relations.map((relation) => pick(relation) ?? Promise.resolve(undefined)),
  );
  return resolved
    .filter((issue): issue is IssueRefLike => Boolean(issue))
    .map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
    }));
}

/**
 * Builds a ProjectIssue from a Linear issue, resolving its explicit
 * blocks/blockedBy relations. Exported as a free function — not a class
 * method — so both `listProjectIssues` and `getIssue` share one
 * implementation without duplicating relation-loading logic, and so it's
 * unit-testable in isolation (see issue-tracker.test.ts).
 */
export async function resolveProjectIssue(
  issue: IssueLike,
): Promise<ProjectIssue> {
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
        connection.nodes.map((issue: Issue) => resolveProjectIssue(issue)),
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

  async getIssue(idOrIdentifier: string): Promise<ProjectIssue> {
    try {
      const issue = await this.client.issue(idOrIdentifier);
      return await resolveProjectIssue(issue);
    } catch (err) {
      throw new Error(
        `Linear: failed to load issue "${idOrIdentifier}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}
