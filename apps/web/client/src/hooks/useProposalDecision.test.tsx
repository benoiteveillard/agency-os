// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProposalCard } from "../components/ProposalCard.js";
import type { ProposalPresentation } from "../types.js";

const proposal: ProposalPresentation = {
  proposalId: "proposal-retry",
  kind: "linear_create_issue",
  title: "Follow up on approval",
  description: "Ask the account owner for an update.",
  priority: 2,
  teamId: "team-1",
  projectId: "project-1",
  projectName: "Acme Website Migration",
  rationale: "Approval is outstanding.",
  evidenceIds: ["linear:JUS-6"],
  expiresAt: "2030-01-01T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("proposal decision retry", () => {
  it("surfaces a dropped connection instead of staying on Approving, and can retry", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        Response.json({
          proposalId: proposal.proposalId,
          decision: "approved",
          decidedAt: "2030-01-01T00:00:00.000Z",
          execution: { outcome: "execution_disabled" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(<ProposalCard proposal={proposal} evidenceById={new Map()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Approve and create issue" }),
    );
    await screen.findByText(/may or may not have been recorded/);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Approval recorded/);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      decision: "approve",
    });
  });

  it.each([
    ["reject", "Reject", "rejected"],
    ["approve", "Approve and create issue", "approved"],
  ] as const)(
    "preserves the user's %s decision after an in-progress response",
    async (decision, button, auditDecision) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            {
              error: {
                code: "proposal_in_progress",
                message: "Decision is processing.",
              },
            },
            { status: 409 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json({
            proposalId: proposal.proposalId,
            decision: auditDecision,
            decidedAt: "2026-09-16T12:00:00.000Z",
            ...(decision === "approve"
              ? { execution: { outcome: "execution_disabled" } }
              : {}),
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      render(<ProposalCard proposal={proposal} evidenceById={new Map()} />);

      fireEvent.click(screen.getByRole("button", { name: button }));
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

      await screen.findByText(
        decision === "reject" ? "Rejected" : "Approval recorded",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toBe("/api/proposals/proposal-retry/decide");
        expect(JSON.parse(options.body)).toEqual({ decision });
      }
    },
  );
});
