import { describe, it, expect } from "vitest";
import { render, screen } from "@/test/render";
import { GemPortfolioCard } from "./GemPortfolioCard";
import { gemPosition } from "@/test/gem-fixtures";

describe("GemPortfolioCard", () => {
  it("wraps a long fund name instead of cutting it off", () => {
    // "iShares MSCI ACWI UCITS ETF USD Acc (IUSQ)" does not fit a card at any
    // sensible width, and truncating hides the share class that tells two
    // otherwise identical funds apart.
    render(
      <GemPortfolioCard
        position={gemPosition({
          current: {
            role: null,
            securityId: "sec-iusq",
            symbol: "IUSQ",
            name: "iShares MSCI ACWI UCITS ETF USD Acc",
            quantity: 12,
            marketValue: 1000,
            isTargetInstrument: false,
            matchPercent: 0,
            matchedByInstrument: true,
            isCash: false,
            matchedMarkets: [],
          },
        })}
        noAccount={false}
      />,
    );

    const value = screen.getByText(/iShares MSCI ACWI UCITS ETF USD Acc/);
    expect(value.className).not.toContain("truncate");
    expect(value.closest("dd")?.className).toContain("break-words");
  });

  it("names cash as cash when it is the largest position", () => {
    // Cash has no ticker and no name, so the label helper used to fall through
    // to "not assigned" -- an account sitting mostly in cash reported its
    // largest position as a gap in the strategy's configuration.
    render(
      <GemPortfolioCard
        position={gemPosition({
          current: {
            role: null,
            isCash: true,
            securityId: null,
            symbol: null,
            name: null,
            quantity: null,
            marketValue: 9000,
            isTargetInstrument: false,
            matchPercent: 0,
            matchedByInstrument: false,
            matchedMarkets: [],
          },
        })}
        noAccount={false}
      />,
    );

    expect(screen.getByText(/Cash/)).toBeInTheDocument();
    expect(screen.queryByText(/Not assigned/)).not.toBeInTheDocument();
  });

  it("counts the positions instead of naming one as the portfolio", () => {
    // The fixture holds three securities across one account. Calling the
    // largest of them "the current instrument" and appending "+2" described
    // the accounts as being in SPY, which they are not.
    render(<GemPortfolioCard position={gemPosition()} noAccount={false} />);

    expect(screen.getByText("Positions in the accounts")).toBeInTheDocument();
    expect(
      screen.getByText("3 instruments across 1 account"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Currently held")).toBeNull();
    // The largest is still shown -- as the largest, and nothing more.
    expect(screen.getByText("Largest position")).toBeInTheDocument();
    expect(screen.getByText(/SPDR S&P 500 ETF \(SPY\)/)).toBeInTheDocument();
    expect(
      screen.getByText("iShares MSCI EM IMI ETF (EMIM)"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "In the target instrument" }),
    ).toHaveAttribute("aria-valuenow", "64");
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("keeps the exposure estimate apart from the allocation", () => {
    render(
      <GemPortfolioCard
        position={gemPosition({
          exactTargetPercent: 0,
          marketExposurePercent: 41,
        })}
        noAccount={false}
      />,
    );

    expect(screen.getByText("In the target instrument")).toBeInTheDocument();
    expect(
      screen.getByText("Estimated exposure to the target market"),
    ).toBeInTheDocument();
    expect(screen.getByText("41%")).toBeInTheDocument();
    // Holding funds with 41% of the same exposure is 0% of the instruction.
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0",
    );
  });

  it("says the exposure is unknown rather than showing zero", () => {
    render(
      <GemPortfolioCard
        position={gemPosition({
          marketExposurePercent: null,
          marketExposureAvailable: false,
          marketExposureDimension: null,
        })}
        noAccount={false}
      />,
    );
    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("reads as compliant when no change is required", () => {
    render(
      <GemPortfolioCard
        position={gemPosition({
          exactTargetPercent: 100,
          changeRequired: false,
        })}
        noAccount={false}
      />,
    );
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("omits the progress value when compliance is unknown", () => {
    render(
      <GemPortfolioCard
        position={gemPosition({ exactTargetPercent: null })}
        noAccount={false}
      />,
    );
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow",
    );
    expect(screen.getAllByText("Not available").length).toBeGreaterThan(0);
  });

  it("shows no largest-position row for empty accounts", () => {
    render(
      <GemPortfolioCard
        position={gemPosition({ current: null, holdings: [] })}
        noAccount={false}
      />,
    );
    expect(screen.queryByText("Largest position")).toBeNull();
    expect(
      screen.getByText("0 instruments across 1 account"),
    ).toBeInTheDocument();
  });

  it("asks for an account when the strategy has none", () => {
    render(<GemPortfolioCard position={null} noAccount />);
    expect(screen.getByText("No account assigned")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
