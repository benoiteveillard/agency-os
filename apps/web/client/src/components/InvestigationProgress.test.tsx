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
    expect(screen.getByText(/GitHub failed/)).toBeInTheDocument();
  });
  it("shows a neutral starting state before receiving any source event", () => {
    render(<InvestigationProgress activities={[]} />);
    expect(screen.getByText(/Usually takes a minute/)).toBeInTheDocument();
    expect(screen.queryByText("Linear")).not.toBeInTheDocument();
  });
  it("shows nothing still running once the run has stopped", () => {
    render(
      <InvestigationProgress
        stopped
        activities={[
          { kind: "source", source: "slack", status: "in_progress" },
          { kind: "assessing", status: "in_progress" },
        ]}
      />,
    );
    expect(screen.getByText("Investigation stopped")).toBeInTheDocument();
    expect(screen.getByText(/Didn.t finish checking/)).toBeInTheDocument();
    expect(document.querySelector(".progress-item--in_progress")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
  it("lists sources before the analysis step, whatever order they started in", () => {
    render(
      <InvestigationProgress
        activities={[
          { kind: "assessing", status: "in_progress" },
          { kind: "source", source: "linear", status: "done", ok: true },
        ]}
      />,
    );
    const rows = [...document.querySelectorAll(".progress-item__label")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Linear",
      "Weighing the evidence",
    ]);
  });
  it("keeps CI capitalized in the hint", () => {
    render(
      <InvestigationProgress
        activities={[
          { kind: "source", source: "github", status: "in_progress" },
        ]}
      />,
    );
    expect(screen.getByText(/pull requests and CI/)).toBeInTheDocument();
  });
});
