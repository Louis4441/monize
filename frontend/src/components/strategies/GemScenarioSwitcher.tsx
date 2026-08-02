"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import {
  EntitySwitcher,
  type EntitySwitcherItem,
} from "@/components/ui/EntitySwitcher";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import type { GemStrategyRef } from "@/types/gem-strategy";

interface GemScenarioSwitcherProps {
  /**
   * The scenario on screen; it is not offered as a destination. Null before
   * the first save: there is nothing yet to switch away from or delete, so
   * only "start another one" is offered.
   */
  currentId: string | null;
  currentName: string;
  scenarios: readonly GemStrategyRef[];
  onSelect: (id: string) => void;
  /**
   * Resolves true when the scenario was created. The parent catches its own
   * errors, so a plain `Promise<void>` looked identical whether the server
   * accepted the name or rejected it -- and the dialog closed on both, taking
   * the typed name with it.
   */
  onCreate: (name: string) => Promise<boolean>;
  /** Resolves true when the scenario was deleted; see `onCreate`. */
  onDelete: (id: string) => Promise<boolean>;
  /** True while a scenario call is in flight, to stop a double submit. */
  busy?: boolean;
}

/**
 * The scenario controls beside the report title: switch to another saved
 * strategy, start one, or delete this one.
 *
 * Switching is `EntitySwitcher`, the same caret the security, payee and account
 * detail pages use, so the menu, filter and keyboard behaviour are defined once.
 * Creating and deleting sit next to it because a scenario is only useful
 * alongside another one to compare it with.
 *
 * Deleting takes the evaluation history with it, which is the part that cannot
 * be rebuilt -- the confirmation says so rather than asking a generic "are you
 * sure".
 */
export function GemScenarioSwitcher({
  currentId,
  currentName,
  scenarios,
  onSelect,
  onCreate,
  onDelete,
  busy = false,
}: GemScenarioSwitcherProps) {
  const t = useTranslations("strategies");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const items = useMemo<EntitySwitcherItem[]>(
    () =>
      scenarios.map((scenario) => ({
        id: scenario.id,
        primary: scenario.name,
      })),
    [scenarios],
  );

  const submitCreate = async () => {
    // Only clear and close on success: a failed create leaves the name in the
    // field and the dialog open, so retrying is one click rather than typing
    // it again.
    if (!(await onCreate(newName.trim()))) return;
    setNewName("");
    setCreating(false);
  };

  return (
    <>
      <span className="flex items-center gap-0.5">
        {currentId !== null && items.length > 1 && (
          <EntitySwitcher
            currentId={currentId}
            items={items}
            onSelect={onSelect}
            triggerLabel={t("gem.scenarios.switch")}
            filterPlaceholder={t("gem.scenarios.filterPlaceholder")}
            noMatchesLabel={t("gem.scenarios.noMatches")}
          />
        )}
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={busy}
          title={t("gem.scenarios.create")}
          aria-label={t("gem.scenarios.create")}
          className="rounded p-1 text-gray-400 hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:hover:text-blue-400"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
        </button>
        {/* Deleting the only scenario would leave nothing to report on, and the
            unconfigured report is reachable by clearing it instead. */}
        {currentId !== null && scenarios.length > 1 && (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={busy}
            title={t("gem.scenarios.delete")}
            aria-label={t("gem.scenarios.delete")}
            className="rounded p-1 text-gray-400 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 dark:hover:text-red-400"
          >
            <TrashIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </span>

      <Modal
        isOpen={creating}
        onClose={() => setCreating(false)}
        maxWidth="sm"
        pushHistory
        className="p-6"
      >
        <h2 className="mb-1 text-xl font-bold text-gray-900 dark:text-gray-100">
          {t("gem.scenarios.createTitle")}
        </h2>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          {t("gem.scenarios.createHint")}
        </p>
        <Input
          label={t("gem.scenarios.nameLabel")}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder={t("gem.scenarios.namePlaceholder")}
          maxLength={100}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setCreating(false)}
          >
            {t("gem.scenarios.cancel")}
          </Button>
          <Button type="button" onClick={submitCreate} disabled={busy}>
            {t("gem.scenarios.createConfirm")}
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={confirmingDelete}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          // Same rule as the create dialog: a rejected delete keeps the
          // confirmation on screen with its context intact.
          if (currentId && !(await onDelete(currentId))) return;
          setConfirmingDelete(false);
        }}
        pushHistory
        title={t("gem.scenarios.deleteTitle")}
        message={t("gem.scenarios.deleteMessage", { name: currentName })}
        confirmLabel={t("gem.scenarios.delete")}
        variant="danger"
      />
    </>
  );
}
