import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test/render";
import { GemStrategyHeader } from "./GemStrategyHeader";

describe("GemStrategyHeader", () => {
  const baseProps = {
    strategyId: "strategy-1",
    strategyName: "GEM Strategy",
    scenarios: [{ id: "strategy-1", name: "GEM Strategy" }],
    onSelectScenario: vi.fn(),
    onCreateScenario: vi.fn().mockResolvedValue("done" as const),
    onDeleteScenario: vi.fn().mockResolvedValue("done" as const),
    scenarioBusy: false,
    cadence: "MONTHLY" as const,
    lookbackMonths: 12,
    nextEvaluationOn: "2025-08-31",
    daysUntilNextEvaluation: 28,
  };

  it("shows the way back, title, cadence and days remaining", () => {
    render(<GemStrategyHeader {...baseProps} onEditSettings={vi.fn()} />);

    // The same back link the other report pages carry, above the title.
    expect(
      screen.getByRole("link", { name: "Back to Reports" }),
    ).toHaveAttribute("href", "/reports");
    expect(
      screen.getByRole("heading", { level: 1, name: /GEM Strategy/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Global equities momentum – equities versus a safe asset",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Evaluation frequency: monthly"),
    ).toBeInTheDocument();
    expect(screen.getByText(/in 28 days/)).toBeInTheDocument();
  });

  /**
   * Invariant: copy naming the momentum window names the configured one.
   * Canonical adversarial input: a configuration away from the default.
   * Minimal mutation: hardcode 12 in the `explainer` catalog string.
   * Test that fails under it: this one.
   */
  it("explains the strategy with the window it is actually run on", () => {
    render(
      <GemStrategyHeader
        {...baseProps}
        lookbackMonths={6}
        onEditSettings={vi.fn()}
      />,
    );

    // The tooltip's text is on the trigger, so it is readable without hover.
    const explainer = screen.getByLabelText(/Global Equities Momentum/);
    expect(explainer).toHaveAccessibleName(
      expect.stringContaining("6-month return"),
    );
    expect(explainer).not.toHaveAccessibleName(
      expect.stringContaining("12-month return"),
    );
  });

  it("omits the day count when it is unknown", () => {
    render(
      <GemStrategyHeader
        {...baseProps}
        daysUntilNextEvaluation={null}
        onEditSettings={vi.fn()}
      />,
    );
    expect(screen.getByText(/Next evaluation:/)).toBeInTheDocument();
    expect(screen.queryByText(/in 28 days/)).not.toBeInTheDocument();
  });

  it("says the evaluation is unscheduled without a date", () => {
    render(
      <GemStrategyHeader
        {...baseProps}
        nextEvaluationOn={null}
        onEditSettings={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Next evaluation not scheduled"),
    ).toBeInTheDocument();
  });

  it("reports the settings request", () => {
    const onEditSettings = vi.fn();
    render(
      <GemStrategyHeader {...baseProps} onEditSettings={onEditSettings} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Edit settings/ }));
    expect(onEditSettings).toHaveBeenCalledOnce();
  });
});
