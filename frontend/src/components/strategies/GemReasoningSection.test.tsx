import { describe, it, expect } from "vitest";
import { render, screen } from "@/test/render";
import { GemReasoningSection } from "./GemReasoningSection";
import { gemAssets, gemSignal } from "@/test/gem-fixtures";

describe("GemReasoningSection", () => {
  it("labels the momentum figures with the configured window, not a fixed 12", () => {
    render(<GemReasoningSection signal={gemSignal()} lookbackMonths={6} />);
    // Both steps report the window: the absolute test and the equity ranking.
    expect(screen.getAllByText(/6-month return/)).toHaveLength(2);
    expect(screen.queryAllByText(/12-month return/)).toHaveLength(0);
  });

  it("names the risk-free leg as the benchmark, not the safe asset", () => {
    const signal = gemSignal();
    render(
      <GemReasoningSection
        signal={{
          ...signal,
          absolute: {
            ...signal.absolute,
            benchmark: { ...gemAssets[4], momentum12m: 5.13, rank: null },
          },
        }}
        lookbackMonths={12}
      />,
    );

    // The yardstick is BIL; IEF is only what a RISK-OFF period would hold.
    expect(
      screen.getByText("SPY versus BIL, 12-month return"),
    ).toBeInTheDocument();
    expect(screen.getByText("Risk-free benchmark")).toBeInTheDocument();
    expect(screen.getByText("+5.13%")).toBeInTheDocument();
  });

  it("shows both steps with the figures behind a RISK-ON signal", () => {
    render(<GemReasoningSection signal={gemSignal()} lookbackMonths={12} />);

    // The two questions, asked in words, and answered with the figures they
    // were decided on.
    expect(
      screen.getByText("Stay in equities, or move to bonds?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "SPY (+15.42%) came out ahead of IEF (+4.21%), so the strategy stays in equities.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("SPY versus IEF, 12-month return"),
    ).toBeInTheDocument();
    expect(screen.getByText("Result: RISK-ON")).toBeInTheDocument();
    // SPY appears in both steps: the absolute test and the equity ranking.
    expect(screen.getAllByText("+15.42%").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("+11.21 pp")).toBeInTheDocument();
    // Not a "buffer": nothing here is hysteresis, so the copy says what would
    // actually flip the signal instead of implying a cushion.
    expect(
      screen.getByText("Equity advantage over the benchmark"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The signal moves to bonds once SPY’s return falls below IEF’s.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Buffer/)).toBeNull();

    expect(
      screen.getByText("Staying in equities — which market?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "EMIM had the strongest return (+29.87%), so that market is the target for this period.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ranking of 3 equity markets, 12-month return"),
    ).toBeInTheDocument();
    expect(screen.getByText("Result: 100% EMIM")).toBeInTheDocument();
    expect(screen.getByText("EMIM leads SPY by 14.45 pp.")).toBeInTheDocument();
  });

  it("deactivates step 2 and explains why while RISK-OFF", () => {
    const signal = gemSignal();
    render(
      <GemReasoningSection
        signal={gemSignal({
          state: "RISK_OFF",
          target: gemAssets[3],
          absolute: {
            ...signal.absolute,
            equity: { ...gemAssets[0], momentum12m: -1.28, rank: 3 },
            spreadPp: -5.04,
            result: "RISK_OFF",
          },
          relative: { ...signal.relative, applied: false },
        })}
        lookbackMonths={12}
      />,
    );

    expect(screen.getByText("Result: RISK-OFF")).toBeInTheDocument();
    expect(screen.getByText("Not applied")).toBeInTheDocument();
    expect(
      screen.getByText(
        "SPY (-1.28%) did not come out ahead of IEF (+4.21%), so the strategy moves to the safe asset IEF.",
      ),
    ).toBeInTheDocument();
    // The second step is not dimmed and left to be interpreted: it says it was
    // not asked, and what was done instead.
    expect(
      screen.getByText("Which equity market? Not asked this period"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This step is not applied: the first decision already moved the strategy to IEF, so the ranking changes nothing this period.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The signal returns to equities once SPY’s return rises above IEF’s.",
      ),
    ).toBeInTheDocument();
  });

  it("explains an unknown margin rather than printing a zero", () => {
    const signal = gemSignal();
    render(
      <GemReasoningSection
        signal={gemSignal({
          absolute: {
            ...signal.absolute,
            equity: { ...gemAssets[0], momentum12m: null, rank: null },
            spreadPp: null,
          },
        })}
        lookbackMonths={12}
      />,
    );
    expect(
      screen.getByText(/margin cannot be shown without a 12-month return/),
    ).toBeInTheDocument();
  });

  it("reports an unknown lead over second place", () => {
    const signal = gemSignal();
    render(
      <GemReasoningSection
        signal={gemSignal({ relative: { ...signal.relative, leadPp: null } })}
        lookbackMonths={12}
      />,
    );
    expect(
      screen.getAllByText("The lead over second place is not available.")
        .length,
    ).toBe(1);
  });

  it("asks for instruments when there is no ranking", () => {
    const signal = gemSignal();
    render(
      <GemReasoningSection
        signal={gemSignal({
          relative: { ...signal.relative, ranking: [], leadPp: null },
        })}
        lookbackMonths={12}
      />,
    );
    expect(screen.getByText("No ranking available")).toBeInTheDocument();
  });

  it("renders an empty state without a signal", () => {
    render(<GemReasoningSection signal={null} lookbackMonths={12} />);
    expect(screen.getByText("No evaluation to explain")).toBeInTheDocument();
  });
});
