import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@/test/render";
import { GemScenarioSwitcher } from "./GemScenarioSwitcher";

const twoScenarios = [
  { id: "strategy-1", name: "GEM 12m" },
  { id: "strategy-2", name: "GEM 6m" },
];

const renderSwitcher = (overrides: Record<string, unknown> = {}) => {
  const onSelect = vi.fn();
  // True on success, as the parent now reports: `undefined` described a
  // contract it no longer has, and every dialog below would stay open on it.
  const onCreate = vi.fn().mockResolvedValue(true);
  const onDelete = vi.fn().mockResolvedValue(true);
  render(
    <GemScenarioSwitcher
      currentId="strategy-1"
      currentName="GEM 12m"
      scenarios={twoScenarios}
      onSelect={onSelect}
      onCreate={onCreate}
      onDelete={onDelete}
      {...overrides}
    />,
  );
  return { onSelect, onCreate, onDelete };
};

describe("GemScenarioSwitcher", () => {
  it("offers the other scenarios and reports the pick", async () => {
    const { onSelect } = renderSwitcher();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Switch scenario" }));
    });
    // The scenario on screen is not offered as a destination.
    expect(screen.queryByRole("menuitem", { name: /GEM 12m/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /GEM 6m/ }));
    });

    expect(onSelect).toHaveBeenCalledWith("strategy-2");
  });

  it("hides the switcher until there is somewhere to switch to", () => {
    renderSwitcher({ scenarios: [twoScenarios[0]] });

    expect(
      screen.queryByRole("button", { name: "Switch scenario" }),
    ).toBeNull();
    // Creating one is still offered; that is how the second comes to exist.
    expect(
      screen.getByRole("button", { name: "New scenario" }),
    ).toBeInTheDocument();
  });

  it("creates a scenario with the typed name, trimmed", async () => {
    const { onCreate } = renderSwitcher();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New scenario" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Scenario name"), {
        target: { value: "  IKZE quarterly  " },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(onCreate).toHaveBeenCalledWith("IKZE quarterly");
    // Accepted, so the dialog is done with.
    expect(screen.queryByLabelText("Scenario name")).not.toBeInTheDocument();
  });

  /**
   * The parent catches its own errors, so the switcher saw a resolved promise
   * whether the server accepted the scenario or rejected it, and closed either
   * way -- discarding the name the user had just typed.
   */
  it("keeps the create dialog and the typed name when the server refuses", async () => {
    const onCreate = vi.fn().mockResolvedValue(false);
    renderSwitcher({ onCreate });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New scenario" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Scenario name"), {
        target: { value: "IKZE quarterly" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(onCreate).toHaveBeenCalledWith("IKZE quarterly");
    const field = screen.getByLabelText("Scenario name") as HTMLInputElement;
    expect(field).toBeInTheDocument();
    expect(field.value).toBe("IKZE quarterly");
  });

  it("warns that deleting takes the evaluation history with it", async () => {
    const { onDelete } = renderSwitcher();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete scenario" }));
    });
    expect(screen.getByText(/whole evaluation history/)).toBeInTheDocument();
    expect(screen.getByText(/GEM 12m/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen
          .getAllByRole("button", { name: "Delete scenario" })
          .at(-1) as HTMLElement,
      );
    });
    expect(onDelete).toHaveBeenCalledWith("strategy-1");
    expect(
      screen.queryByText(/whole evaluation history/),
    ).not.toBeInTheDocument();
  });

  it("keeps the delete confirmation open when the server refuses", async () => {
    const onDelete = vi.fn().mockResolvedValue(false);
    renderSwitcher({ onDelete });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete scenario" }));
    });
    await act(async () => {
      fireEvent.click(
        screen
          .getAllByRole("button", { name: "Delete scenario" })
          .at(-1) as HTMLElement,
      );
    });

    expect(onDelete).toHaveBeenCalledWith("strategy-1");
    // Still on screen, with its context, so retry is one click.
    expect(screen.getByText(/whole evaluation history/)).toBeInTheDocument();
  });

  it("never offers to delete the last scenario", () => {
    renderSwitcher({ scenarios: [twoScenarios[0]] });

    // Deleting it would leave nothing to report on; clearing it is the way out.
    expect(
      screen.queryByRole("button", { name: "Delete scenario" }),
    ).toBeNull();
  });

  it("locks the controls while a scenario call is in flight", () => {
    renderSwitcher({ busy: true });

    expect(screen.getByRole("button", { name: "New scenario" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete scenario" }),
    ).toBeDisabled();
  });
});
