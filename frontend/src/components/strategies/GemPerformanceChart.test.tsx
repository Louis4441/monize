import { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@/test/render";
import { GemPerformanceChart } from "./GemPerformanceChart";
import { gemAssets, gemPerformance } from "@/test/gem-fixtures";

/**
 * Recharts stand-in that also *invokes* the two render props the chart supplies
 * -- the tooltip body and the end-of-line label -- so their output is asserted
 * rather than merely constructed. `Line` is asked for a label at the last point
 * (where it should render) and at the first (where it should not).
 */
vi.mock("recharts", async () => {
  const base = (await import("@/test/recharts-mock")).rechartsMock();
  return {
    ...base,
    Tooltip: ({ content }: { content?: (props: unknown) => ReactNode }) =>
      typeof content === "function" ? (
        <div data-testid="tooltip">
          {content({
            active: true,
            payload: [
              {
                payload: {
                  ts: new Date("2025-08-01T00:00:00").getTime(),
                  US_EQUITY: 15.42,
                  EX_US_EQUITY: 8.31,
                  EM_EQUITY: 29.87,
                  SAFE: null,
                },
              },
            ],
          })}
          {content({ active: false, payload: [] })}
        </div>
      ) : null,
    Line: ({ label }: { label?: (props: unknown) => ReactNode }) =>
      typeof label === "function" ? (
        <div data-testid="line-labels">
          {label({ x: 120, y: 40, value: 29.87, index: 2 })}
          {label({ x: 0, y: 0, value: 0, index: 0 })}
        </div>
      ) : null,
  };
});

const baseProps = {
  assets: gemAssets,
  winnerRole: "EM_EQUITY" as const,
  range: "1Y" as const,
  isLoading: false,
};

describe("GemPerformanceChart", () => {
  it("titles the window, legends every asset and marks the winner", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance()}
        onRangeChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("region", {
        name: /Asset performance – last 12 months/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("S&P 500 (SPY)")).toBeInTheDocument();
    expect(screen.getByText("Emerging markets (EMIM)")).toBeInTheDocument();
    expect(screen.getByText("(winner)")).toBeInTheDocument();
    expect(screen.getByText(/in its own listing currency/)).toBeInTheDocument();
  });

  it("offers every range and reports the selection", () => {
    const onRangeChange = vi.fn();
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance()}
        onRangeChange={onRangeChange}
      />,
    );

    const group = screen.getByRole("group", { name: "Chart range" });
    expect(group.querySelectorAll("button")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "1Y" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "3Y" }));
    expect(onRangeChange).toHaveBeenCalledWith("3Y");
  });

  it("toggles the legend on narrow screens", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance()}
        onRangeChange={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Show legend" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide legend" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("notes when the range is not fully covered", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance({ incomplete: true })}
        onRangeChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/do not cover the whole window/),
    ).toBeInTheDocument();
  });

  it("shows an empty state when no asset has prices", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={null}
        onRangeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("No price history")).toBeInTheDocument();
    // The range switcher stays usable so the user can widen the window.
    expect(
      screen.getByRole("group", { name: "Chart range" }),
    ).toBeInTheDocument();
  });

  it("skips a role that has no observations in the window", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance({
          points: [
            { date: "2025-01-01", values: { US_EQUITY: 2, EM_EQUITY: null } },
          ],
        })}
        onRangeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("S&P 500 (SPY)")).toBeInTheDocument();
    expect(
      screen.queryByText("Emerging markets (EMIM)"),
    ).not.toBeInTheDocument();
  });

  it("renders a skeleton while a range change is in flight", () => {
    const { container } = render(
      <GemPerformanceChart
        {...baseProps}
        isLoading
        performance={gemPerformance()}
        onRangeChange={vi.fn()}
      />,
    );
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("falls back to the role name when an asset has no ticker", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        assets={[{ role: "SAFE", securityId: null, symbol: null, name: null }]}
        winnerRole={null}
        performance={gemPerformance({
          points: [{ date: "2025-01-01", values: { SAFE: 1 } }],
        })}
        onRangeChange={vi.fn()}
      />,
    );
    // Once in the legend, once in the tooltip row for the same role.
    expect(screen.getAllByText("Safe asset")).toHaveLength(2);
  });

  it("builds a tooltip listing every asset, marking a missing observation", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance()}
        onRangeChange={vi.fn()}
      />,
    );

    const tooltip = screen.getByTestId("tooltip");
    expect(tooltip).toHaveTextContent("SPY");
    expect(tooltip).toHaveTextContent("+29.87%");
    // The safe asset had no observation on that date: unknown, not zero.
    expect(tooltip).toHaveTextContent("Not available");
  });

  it("labels the end of each line once, at its last observation", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance()}
        onRangeChange={vi.fn()}
      />,
    );

    const labelSets = screen.getAllByTestId("line-labels");
    expect(labelSets).toHaveLength(4);
    // Only the last-point call renders text; the first-point call renders none.
    expect(labelSets[0].querySelectorAll("text")).toHaveLength(1);
    expect(labelSets[0].querySelector("text")).toHaveTextContent("+29.87%");
  });

  it("draws today's portfolio as a simulation, and says what it is not", () => {
    render(
      <GemPerformanceChart
        {...baseProps}
        performance={gemPerformance()}
        onRangeChange={vi.fn()}
      />,
    );

    // The line is legible as a hypothetical, in the legend and in the note.
    // In the legend specifically: the note under the chart explains the line,
    // and the key above it did not list it at all, so the one place a reader
    // looks to find out what a line is had nothing to say about this one.
    const legend = document.getElementById("gem-chart-legend") as HTMLElement;
    expect(
      within(legend).getByText("Today’s portfolio — simulated"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/applies today’s instrument proportions at the start/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /does not reproduce historical transactions, cash flows, cash or currency movements/,
      ),
    ).toBeInTheDocument();
  });

  it("says why the simulated line starts late", () => {
    const performance = gemPerformance();
    render(
      <GemPerformanceChart
        {...baseProps}
        onRangeChange={vi.fn()}
        performance={{
          ...performance,
          currentPortfolio: {
            ...performance.currentPortfolio!,
            completeRange: false,
            startsOn: "2025-02-01",
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        /simulation starts later because at least one of the instruments/,
      ),
    ).toBeInTheDocument();
  });

  it("explains an absent simulation instead of drawing a partial one", () => {
    const performance = gemPerformance();
    render(
      <GemPerformanceChart
        {...baseProps}
        onRangeChange={vi.fn()}
        performance={{
          ...performance,
          currentPortfolio: {
            points: [],
            totalReturnPercent: null,
            completeRange: false,
            startsOn: null,
            includedHoldings: [],
            unavailableReason: "MISSING_PRICE_HISTORY",
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        /no usable price history, so the simulation is not shown/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Today’s portfolio — simulated"),
    ).not.toBeInTheDocument();
  });
});
