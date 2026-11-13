import { LinearClient } from "@linear/sdk";
import { z } from "zod";
import { isOverdue } from "./overdue.js";

export const relatedIssueRefSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
});
export type RelatedIssueRef = z.infer<typeof relatedIssueRefSchema>;

export const projectIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  stateType: z.string(),
  priorityLabel: z.string(),
  dueDate: z.string().nullable(),
  overdue: z.boolean(),
  updatedAt: z.string(),
  /** Issues this one must wait on (explicit Linear `blocks` relation, incoming). */
  blockedBy: z.array(relatedIssueRefSchema),
  /** Issues this one is holding up (explicit Linear `blocks` relation, outgoing). */
  blocks: z.array(relatedIssueRefSchema),
});
export type ProjectIssue = z.infer<typeof projectIssueSchema>;

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  targetDate: z.string().nullable(),
  /** Linear's own health signal for the project: "onTrack" | "atRisk" | "offTrack", if set. */
  health: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectIssuesResultSchema = z.object({
  project: projectSummarySchema,
  issues: z.array(projectIssueSchema),
  /**
   * True when a page cap was hit, so issues (or an issue's relations) exist
   * that this result doesn't contain. The model is told, rather than left to
   * read a partial list as the whole project.
   */
  truncated: z.boolean(),
});
export type ProjectIssuesResult = z.infer<typeof projectIssuesResultSchema>;

/**
 * Read-only port for issue-tracker data. LinearIssueTracker (direct GraphQL)
 * and McpLinearIssueTracker (via the custom Linear MCP server, see
 * mcp/linear) both implement this; agent/tool code depends on neither
 * directly (AGENTS.md #11).
 */
export interface IssueTracker {
  listProjectIssues(projectId: string): Promise<ProjectIssuesResult>;
  getIssue(idOrIdentifier: string): Promise<ProjectIssue>;
}

// --- Raw GraphQL shapes, validated at the boundary. Relation targets are
// nullable here even though Linear's schema says otherwise: a relation to an
// issue the key can't see is dropped rather than failing the whole call.

const rawRefSchema = relatedIssueRefSchema.nullable().optional();
const rawRelationsSchema = z.object({
  nodes: z.array(
    z.object({
      type: z.string(),
      issue: rawRefSchema,
      relatedIssue: rawRefSchema,
    }),
  ),
  pageInfo: z.object({ hasNextPage: z.boolean() }),
});

export const rawIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  priorityLabel: z.string(),
  dueDate: z.string().nullable().optional(),
  updatedAt: z.string(),
  state: z.object({ name: z.string(), type: z.string() }).nullable().optional(),
  relations: rawRelationsSchema,
  inverseRelations: rawRelationsSchema,
});
export type RawIssue = z.infer<typeof rawIssueSchema>;

const rawProjectPageSchema = z.object({
  project: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    targetDate: z.string().nullable().optional(),
    health: z.string().nullable().optional(),
    issues: z.object({
      nodes: z.array(rawIssueSchema),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().nullable().optional(),
      }),
    }),
  }),
});

const rawIssueResponseSchema = z.object({ issue: rawIssueSchema });

const PAGE_SIZE = 50;
// Safety cap on pagination. Synthetic demo projects are small (tens of
// issues); this exists to bound worst-case latency/cost, not to handle real
// production volume. Hitting it sets `truncated`.
const MAX_PAGES = 10;
// Per-issue cap on each relation direction, kept small so a page stays well
// inside Linear's query complexity limit. Hitting it also sets `truncated`.
const RELATIONS_PER_ISSUE = 25;

const ISSUE_FIELDS = `
  id identifier title url priorityLabel dueDate updatedAt
  state { name type }
  relations(first: ${RELATIONS_PER_ISSUE}) {
    nodes { type relatedIssue { id identifier title } }
    pageInfo { hasNextPage }
  }
  inverseRelations(first: ${RELATIONS_PER_ISSUE}) {
    nodes { type issue { id identifier title } }
    pageInfo { hasNextPage }
  }`;

/**
 * One request per page of issues, relations included. The SDK's lazy models
 * cost one request for the state and two more for relations per issue, plus
 * one per related issue: 60+ requests for a twenty-issue project.
 */
const PROJECT_ISSUES_QUERY = `
  query ProjectIssues($projectId: String!, $first: Int!, $after: String) {
    project(id: $projectId) {
      id name url targetDate health
      issues(first: $first, after: $after) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const ISSUE_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }`;

function blockRefs(
  nodes: RawIssue["relations"]["nodes"],
  pick: "issue" | "relatedIssue",
): RelatedIssueRef[] {
  return nodes
    .filter((relation) => relation.type === "blocks")
    .map((relation) => relation[pick])
    .filter((ref): ref is RelatedIssueRef => Boolean(ref))
    .map(({ id, identifier, title }) => ({ id, identifier, title }));
}

/** Maps one validated raw issue to the domain shape. Pure, so it's unit-tested directly. */
export function toProjectIssue(
  raw: RawIssue,
  now: Date = new Date(),
): ProjectIssue {
  const dueDate = raw.dueDate ?? null;
  const stateType = raw.state?.type ?? "unknown";
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    state: raw.state?.name ?? "unknown",
    stateType,
    priorityLabel: raw.priorityLabel,
    dueDate,
    overdue: isOverdue(dueDate, stateType, now),
    updatedAt: raw.updatedAt,
    // relations(): this issue is the source; "blocks" means it blocks relatedIssue.
    blocks: blockRefs(raw.relations.nodes, "relatedIssue"),
    // inverseRelations(): this issue is the target; "blocks" means issue blocks it.
    blockedBy: blockRefs(raw.inverseRelations.nodes, "issue"),
  };
}

function relationsTruncated(raw: RawIssue): boolean {
  return (
    raw.relations.pageInfo.hasNextPage ||
    raw.inverseRelations.pageInfo.hasNextPage
  );
}

/** Sends one GraphQL document and resolves to its `data`. */
export type LinearGraphQLRequest = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<unknown>;

export class LinearIssueTracker implements IssueTracker {
  private readonly request: LinearGraphQLRequest;

  /** An API key, or a request function (tests). */
  constructor(auth: string | LinearGraphQLRequest) {
    if (typeof auth === "string") {
      const client = new LinearClient({ apiKey: auth });
      this.request = (query, variables) =>
        client.client.request(query, variables);
    } else {
      this.request = auth;
    }
  }

  async listProjectIssues(projectId: string): Promise<ProjectIssuesResult> {
    try {
      const rawIssues: RawIssue[] = [];
      let after: string | undefined;
      let hasNextPage = true;
      let pagesFetched = 0;
      let project: z.infer<typeof rawProjectPageSchema>["project"] | undefined;

      while (hasNextPage && pagesFetched < MAX_PAGES) {
        const page = rawProjectPageSchema.parse(
          await this.request(PROJECT_ISSUES_QUERY, {
            projectId,
            first: PAGE_SIZE,
            after,
          }),
        );
        project = page.project;
        rawIssues.push(...page.project.issues.nodes);
        hasNextPage = page.project.issues.pageInfo.hasNextPage;
        after = page.project.issues.pageInfo.endCursor ?? undefined;
        pagesFetched += 1;
        // A next page with no cursor can't be fetched; report it as truncated.
        if (hasNextPage && !after) break;
      }

      // The loop runs at least once, so project is set.
      const summary = project!;
      return {
        project: {
          id: summary.id,
          name: summary.name,
          url: summary.url,
          targetDate: summary.targetDate ?? null,
          health: summary.health ?? null,
        },
        issues: rawIssues.map((raw) => toProjectIssue(raw)),
        truncated: hasNextPage || rawIssues.some(relationsTruncated),
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
      const { issue } = rawIssueResponseSchema.parse(
        await this.request(ISSUE_QUERY, { id: idOrIdentifier }),
      );
      return toProjectIssue(issue);
    } catch (err) {
      throw new Error(
        `Linear: failed to load issue "${idOrIdentifier}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }
}
