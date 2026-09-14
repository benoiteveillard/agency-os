import type { IssueWriter, LinearCreateIssueArgs } from "@agency-os/shared";

/**
 * Used for the live integration suite: structurally refuses to write no
 * matter what approval decision is scripted. The live suite is read-only
 * by design (see docs/decisions.md) — this is a second, independent
 * enforcement of that beyond "no live scenario configures a write."
 */
export class RefusingIssueWriter implements IssueWriter {
  async createIssue(
    _args: LinearCreateIssueArgs,
  ): Promise<{ issueId: string }> {
    throw new Error(
      "eval-runner live mode does not support write execution — the live integration suite is read-only by design.",
    );
  }
}
