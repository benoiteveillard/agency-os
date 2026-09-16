// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InvestigationProgress } from "./InvestigationProgress.js";
import { SourcesChecked } from "./SourcesChecked.js";

describe("honest source progress", () => {
  it("does not claim that a source in progress was checked", () => {
    render(
      <InvestigationProgress
        activities={[
          { kind: "source", source: "linear", status: "in_progress" },
        ]}
      />,
    );
    expect(screen.getByText(/Checking project issues/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Checked project issues/),
    ).not.toBeInTheDocument();
  });
  it("labels source failures explicitly during and after investigation", () => {
    const activities = [
      { kind: "source", source: "github", status: "done", ok: false },
    ] as const;
    render(
      <>
        <InvestigationProgress activities={[...activities]} />
        <SourcesChecked activities={[...activities]} />
      </>,
    );
    expect(screen.getByText(/Could not check/)).toBeInTheDocument();
    expect(screen.getByText(/GitHub — check failed/)).toBeInTheDocument();
  });
  it("shows a neutral starting state before receiving any source event", () => {
    render(<InvestigationProgress activities={[]} />);
    expect(
      screen.getByText(/Waiting for the first activity/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Linear")).not.toBeInTheDocument();
  });
});
