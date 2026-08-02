import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test/render";
import { GemNextActionCard } from "./GemNextActionCard";
import { gemAction } from "@/test/gem-fixtures";
import { GemHeldAsset } from "@/types/gem-strategy";

const handlers = () => ({
  onMarkExecuted: vi.fn(),
  onAddTransactions: vi.fn(),
});

/** One sellable position, with only the fields the card renders. */
const heldAsset = (overrides: Partial<GemHeldAsset>): GemHeldAsset => ({
  role: null,
  isCash: false,
  securityId: `sec-${overrides.symbol?.toLowerCase() ?? "x"}`,
  symbol: null,
  name: null,
  quantity: 10,
  marketValue: 1000,
  isTargetInstrument: false,
  matchPercent: null,
  matchIsFloor: false,
  matchedByInstrument: false,
  matchedMarkets: [],
  ...overrides,
});

describe("GemNextActionCard", () => {
  it("spells out the switch, the estimates and both actions", () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction()}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );

    expect(screen.getByText("The strategy signal changed")).toBeInTheDocument();
    expect(screen.getByText("SPDR S&P 500 ETF (SPY)")).toBeInTheDocument();
    // Value and units on one line under each sold position.
    expect(screen.getByText(/51 units/)).toBeInTheDocument();
    expect(screen.getByText("changes to")).toBeInTheDocument();
    expect(
      screen.getByText("iShares MSCI EM IMI ETF (EMIM)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("100% of the strategy accounts"),
    ).toBeInTheDocument();
    expect(screen.getByText("$23,076.26")).toBeInTheDocument();
    expect(screen.getByText("+$4,794.90")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Mark as executed/ }));
    fireEvent.click(screen.getByRole("button", { name: /Add transactions/ }));
    expect(onMarkExecuted).toHaveBeenCalledOnce();
    expect(onAddTransactions).toHaveBeenCalledOnce();
  });

  it("shows the positive state with no buttons when nothing is required", () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ required: false })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(
      screen.getByText("Your portfolio matches the strategy"),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing to do right now/)).toBeInTheDocument();
    // The card's own actions, not every button on it: the help trigger is one
    // too, and has to be, or screen readers announce a nameless tab stop.
    expect(
      screen.queryByRole("button", {
        name: /Mark as executed|Add transactions/,
      }),
    ).not.toBeInTheDocument();
  });

  it("says so when the accounts still do not match a signal marked as done", () => {
    // "Executed" is recorded against the signal; what has to be done is
    // recomputed from the accounts. Deposit cash after a completed switch and
    // both are true at once -- the card used to show only the tick, hiding a
    // live instruction behind it.
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ executed: true })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(
      screen.getByText(
        /You marked this as done, but these accounts still do not match/,
      ),
    ).toBeInTheDocument();
    // Marking it again would do nothing; recording the trades is the way out.
    expect(
      screen.queryByRole("button", { name: /Mark as executed/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Add transactions/ }),
    ).toBeInTheDocument();
  });

  it("says nothing about a mismatch once the accounts match again", () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ executed: true, required: false })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(
      screen.getByText("Your portfolio matches the strategy"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/still do not match/)).not.toBeInTheDocument();
  });

  it("names every security the operation sells, not just the largest", () => {
    // The old card printed the largest holding and "and 3 more instruments",
    // which described a four-fund portfolio as though it were in one of them
    // and never named the three the user also has to sell.
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({
          sellPositions: [
            heldAsset({ symbol: "IUSQ", marketValue: 22949.5 }),
            heldAsset({ symbol: "VWRA", marketValue: 8000 }),
            heldAsset({ symbol: "WTAI", marketValue: 543.12 }),
            heldAsset({ symbol: "AGGG", marketValue: 250 }),
          ],
        })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );

    for (const symbol of ["IUSQ", "VWRA", "WTAI", "AGGG"]) {
      expect(screen.getByText(new RegExp(symbol))).toBeInTheDocument();
    }
    expect(screen.getByText("Sell (4)")).toBeInTheDocument();
    expect(screen.getByText("Buy")).toBeInTheDocument();
    expect(screen.queryByText(/more instrument/)).toBeNull();
    // And no "current instrument" anywhere: the accounts are in four things.
    expect(screen.queryByText("Current instrument")).toBeNull();
  });

  it("says there is nothing to sell for a purchase funded by cash", () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({ sellPositions: [] })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );

    expect(screen.getByText("Nothing to sell")).toBeInTheDocument();
    expect(screen.getByText("Sell (0)")).toBeInTheDocument();
  });

  it("marks unknown values without zeroes", () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction({
          sellPositions: [],
          transferValue: null,
          realizedGainLoss: null,
        })}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(screen.getAllByText("Not available").length).toBeGreaterThan(1);
  });

  it("does not call a strategy with no accounts compliant", () => {
    // The server returns a null action both when the portfolio matches and
    // when there is no portfolio at all, so falling through told a user with
    // nothing assigned that there was nothing to do -- beside a portfolio card
    // on the same row saying no account was assigned.
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={null}
        noAccount
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );

    expect(screen.getByText("No account assigned")).toBeInTheDocument();
    expect(
      screen.queryByText("Your portfolio matches the strategy"),
    ).toBeNull();
  });

  it("says there is nothing to act on when no signal exists", () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={null}
        signalUnavailable
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving={false}
      />,
    );
    expect(
      screen.getByText("There is no signal to act on yet."),
    ).toBeInTheDocument();
  });

  it("disables the primary action while saving", () => {
    const { onMarkExecuted, onAddTransactions } = handlers();
    render(
      <GemNextActionCard
        action={gemAction()}
        signalUnavailable={false}
        onMarkExecuted={onMarkExecuted}
        onAddTransactions={onAddTransactions}
        isSaving
      />,
    );
    expect(
      screen.getByRole("button", { name: /Mark as executed/ }),
    ).toBeDisabled();
  });
});
