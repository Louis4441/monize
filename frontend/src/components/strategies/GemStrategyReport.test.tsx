import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@/test/render";
import { GemStrategyReport } from "./GemStrategyReport";
import { gemAction, gemHistory, gemReport } from "@/test/gem-fixtures";

vi.mock("recharts", async () =>
  (await import("@/test/recharts-mock")).rechartsMock(),
);

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetReport = vi.fn();
const mockMarkExecuted = vi.fn();
vi.mock("@/lib/gem-strategy", () => ({
  gemStrategyApi: {
    getReport: (...args: unknown[]) => mockGetReport(...args),
    markExecuted: (...args: unknown[]) => mockMarkExecuted(...args),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock("react-hot-toast", () => ({
  default: {
    success: (message: string) => mockToastSuccess(message),
    error: (message: string) => mockToastError(message),
  },
}));

vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/investments", () => ({
  investmentsApi: { getSecurities: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function renderReport() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<GemStrategyReport />);
  });
  return result!;
}

describe("GemStrategyReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetReport.mockResolvedValue(gemReport());
  });

  it("answers the four questions on the overview tab", async () => {
    await renderReport();

    // 1. What is the signal?
    expect(
      screen.getByRole("heading", { level: 1, name: "GEM" }),
    ).toBeInTheDocument();
    expect(screen.getByText("RISK-ON")).toBeInTheDocument();
    expect(
      screen.getByText("100% iShares MSCI EM IMI ETF"),
    ).toBeInTheDocument();

    // 2. Why this instrument?
    expect(
      screen.getByText("Stay in equities, or move to bonds?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Staying in equities — which market?"),
    ).toBeInTheDocument();
    expect(screen.getByText("EMIM leads SPY by 14.45 pp.")).toBeInTheDocument();

    // 3. Is my portfolio aligned?
    expect(
      screen.getAllByText("In the target instrument").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("progressbar", { name: "In the target instrument" }),
    ).toHaveAttribute("aria-valuenow", "64");

    // 4. What should I do?
    expect(
      screen.getByRole("heading", { name: /What should I do\?/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Mark as executed/ }),
    ).toBeInTheDocument();

    // The report footer carries the caveats and provenance.
    expect(
      screen.getByText(/Past results do not guarantee/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "example.test/gem" }),
    ).toBeInTheDocument();
  });

  it("requests the 1Y range first and refetches when the range changes", async () => {
    await renderReport();
    expect(mockGetReport).toHaveBeenCalledWith("1Y", undefined);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "MAX", pressed: false }),
      );
    });
    expect(mockGetReport).toHaveBeenLastCalledWith("MAX", undefined);
    expect(screen.getByRole("button", { name: "MAX" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows a retryable error when the report cannot be loaded", async () => {
    mockGetReport.mockRejectedValue(new Error("boom"));
    await renderReport();
    await act(async () => {});
    await waitFor(() =>
      expect(
        screen.getByText("The GEM strategy report could not be loaded."),
      ).toBeInTheDocument(),
    );

    mockGetReport.mockResolvedValue(gemReport());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(screen.getByText("RISK-ON")).toBeInTheDocument();
  });

  it("marks the operation as executed and reloads the report", async () => {
    mockMarkExecuted.mockResolvedValue(
      gemReport({ action: gemAction({ executed: true }) }),
    );
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Mark as executed/ }));
    });

    expect(mockMarkExecuted).toHaveBeenCalledWith("signal-1", "1Y", undefined);
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Operation marked as executed.",
    );
    // The call answers with the refreshed report, so there is nothing left to
    // fetch -- re-reading it was a round trip that could only return the same.
    expect(mockGetReport).toHaveBeenCalledTimes(1);
    // The fixture's accounts still hold the wrong instrument, so the card
    // reports both facts rather than hiding the live instruction behind a tick.
    expect(
      screen.getByText(
        /You marked this as done, but these accounts still do not match/,
      ),
    ).toBeInTheDocument();
  });

  it("surfaces a failure to mark the operation as executed", async () => {
    mockMarkExecuted.mockRejectedValue(new Error("nope"));
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Mark as executed/ }));
    });
    await act(async () => {});

    expect(mockToastError).toHaveBeenCalledWith(
      "Could not mark the operation as executed.",
    );
  });

  it("sends the user to the investments page to enter the trades", async () => {
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add transactions/ }));
    });
    expect(mockPush).toHaveBeenCalledWith("/investments");
  });

  it('switches tabs, including from the "see full history" link', async () => {
    // More rows than the overview shows, so the "see full history" link appears.
    mockGetReport.mockResolvedValue(
      gemReport({
        history: [
          ...gemHistory(),
          ...gemHistory().map((entry, index) => ({
            ...entry,
            id: `${entry.id}-older`,
            evaluatedOn: `2025-0${index + 1}-01`,
          })),
        ],
      }),
    );
    await renderReport();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "My portfolio" }));
    });
    expect(screen.getByRole("tab", { name: "My portfolio" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Strategy position")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Backtest" }));
    });
    expect(screen.getByText("Annualized return")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    });
    expect(screen.getByText("Strategy configuration")).toBeInTheDocument();
    // The tab is editable: assigning the roles is what starts a strategy.
    expect(
      screen.getByRole("button", { name: "Save configuration" }),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /See full history/ }));
    });
    expect(screen.getByRole("tab", { name: "Signals" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens the settings tab from the header button", async () => {
    await renderReport();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Edit settings/ }));
    });
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("renders the first-run state without inventing values", async () => {
    mockGetReport.mockResolvedValue(
      gemReport({
        signal: null,
        position: null,
        action: null,
        performance: null,
        history: [],
        backtest: null,
        warnings: [{ code: "FIRST_RUN" }, { code: "NO_ACCOUNT" }],
      }),
    );
    await renderReport();

    expect(screen.getByText("No signal yet")).toBeInTheDocument();
    expect(screen.getByText("No account assigned")).toBeInTheDocument();
    // A missing signal is the earlier state and keeps its own copy.
    expect(screen.getByText("Nothing to transfer")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nothing moves until the strategy produces its first signal.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No price history")).toBeInTheDocument();
    expect(screen.getByText("No evaluations yet")).toBeInTheDocument();
    expect(
      screen.getByText("There is no signal to act on yet."),
    ).toBeInTheDocument();
    // The first-run notice is explained once, in the banner.
    expect(
      screen.getByText(/has not been evaluated yet —/),
    ).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("reports stale prices and unmapped roles above the cards", async () => {
    mockGetReport.mockResolvedValue(
      gemReport({
        warnings: [
          { code: "STALE_PRICES", roles: ["EX_US_EQUITY"] },
          { code: "UNMAPPED_ROLE", roles: ["SAFE"] },
        ],
      }),
    );
    await renderReport();

    expect(
      screen.getByText(/prices behind this report are not current/),
    ).toBeInTheDocument();
    // The warning names the instrument whose price is behind, not a date the
    // user then has to match to a role themselves. Scoped to the banner: the
    // role is named again by the assets card further down the page.
    expect(
      within(screen.getAllByRole("status")[0]).getByText(
        /Developed markets ex-US/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No instrument is assigned to:/),
    ).toBeInTheDocument();
  });

  /**
   * The report on screen and the scenario selected can drift apart, because
   * the loader keeps the previous report visible while the next one arrives.
   * That is the right thing to look at and the wrong thing to act on: between
   * picking scenario B and B's report landing, the page still shows A -- A's
   * signal id on the button, A's settings in the form. Every one of these
   * proved reproducible against the unkeyed state.
   */
  describe("a selection the rendered report does not describe", () => {
    /** A promise the test resolves when it chooses. */
    const deferred = <T,>() => {
      let settle: (value: T) => void = () => {};
      const promise = new Promise<T>((resolve) => {
        settle = resolve;
      });
      return { promise, settle };
    };

    const switchRange = async (label: string) => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: label }));
      });
    };

    it("will not mark a signal while the newly selected range is still loading", async () => {
      await renderReport();
      const pending = deferred<unknown>();
      mockGetReport.mockReturnValue(pending.promise);

      await switchRange("3M");

      // A is still on screen, B is in flight: the action is not available.
      const button = screen.getAllByRole("button", {
        name: /Mark as executed/,
      })[0];
      await act(async () => {
        fireEvent.click(button);
      });
      expect(mockMarkExecuted).not.toHaveBeenCalled();

      await act(async () => {
        pending.settle(gemReport());
      });
      // ...and it comes back once the two agree again.
      await waitFor(() =>
        expect(
          screen.getAllByRole("button", { name: /Mark as executed/ })[0],
        ).not.toBeDisabled(),
      );
    });

    it("discards a mutation response produced for a range the user has left", async () => {
      await renderReport();

      // A slow mark-executed for 1Y, then the user moves to 3M mid-flight.
      const slowMutation = deferred<unknown>();
      mockMarkExecuted.mockReturnValue(slowMutation.promise);
      const button = screen.getAllByRole("button", {
        name: /Mark as executed/,
      })[0];
      await act(async () => {
        fireEvent.click(button);
      });
      expect(mockMarkExecuted).toHaveBeenCalledTimes(1);

      const threeMonth = gemReport();
      threeMonth.performance = { ...threeMonth.performance!, range: "3M" };
      mockGetReport.mockResolvedValue(threeMonth);
      await switchRange("3M");

      // The 1Y response now lands. It describes a range nobody is looking at.
      const oneYear = gemReport();
      oneYear.performance = { ...oneYear.performance!, range: "1Y" };
      await act(async () => {
        slowMutation.settle(oneYear);
      });

      expect(screen.getByRole("button", { name: "3M" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    it("does not leave a failed load looking like the new selection", async () => {
      await renderReport();
      mockGetReport.mockRejectedValue(new Error("boom"));

      await switchRange("3M");

      // The old report must not stay on screen as though it were the new
      // range's; the shared error presentation takes over instead.
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /Mark as executed/ }),
        ).not.toBeInTheDocument(),
      );
    });
  });
});
