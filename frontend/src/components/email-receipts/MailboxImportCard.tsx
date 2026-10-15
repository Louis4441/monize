"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import toast from "react-hot-toast";
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { emailReceiptsApi } from "@/lib/email-receipts-api";
import { getErrorMessage } from "@/lib/errors";
import type { EmailReceiptImportResult } from "@/types/email-receipts";

/** The server's per-request limits (`mailbox/import`); checked here so a refusal costs no upload. */
export const MAX_IMPORT_FILES = 20;
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
/** The whole request is refused above 100 MB; 1 MB of it is left for the multipart framing. */
export const MAX_IMPORT_TOTAL_BYTES = 99 * 1024 * 1024;

/**
 * No `accept` list can be a gate: a file with no extension (the `mbox` file Apple
 * Mail writes) must stay selectable, and the server reads the content, not the name.
 */
const ACCEPT =
  ".eml,.mbox,.mbx,.zip,.msg,message/rfc822,application/mbox,application/zip,application/vnd.ms-outlook";

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal space-y-0.5 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

/**
 * Upload of exported `.eml`, `.mbox`, `.msg` and `.zip` files into the person's mailbox, the
 * per-file result, and a guide to exporting from the common providers. Rendered
 * only when a mailbox exists: the server answers 404 without one.
 */
export function MailboxImportCard() {
  const t = useTranslations("emailReceipts.mailbox.import");
  const { formatNumber, formatBytes } = useNumberFormat();
  const inputRef = useRef<HTMLInputElement>(null);
  const guideId = useId();

  const [files, setFiles] = useState<File[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<EmailReceiptImportResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const count = (n: number) => formatNumber(n, 0);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    setResult(null);
    if (picked.length > MAX_IMPORT_FILES) {
      setFiles([]);
      setProblem(t("tooMany", { max: count(MAX_IMPORT_FILES) }));
      event.target.value = "";
      return;
    }
    const oversized = picked.find((file) => file.size > MAX_IMPORT_FILE_BYTES);
    if (oversized) {
      setFiles([]);
      setProblem(
        t("tooLarge", {
          name: oversized.name,
          max: formatBytes(MAX_IMPORT_FILE_BYTES),
        }),
      );
      event.target.value = "";
      return;
    }
    const total = picked.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_IMPORT_TOTAL_BYTES) {
      setFiles([]);
      setProblem(
        t("tooLargeTotal", { max: formatBytes(MAX_IMPORT_TOTAL_BYTES) }),
      );
      event.target.value = "";
      return;
    }
    setProblem(null);
    setFiles(picked);
  };

  const handleImport = async () => {
    if (files.length === 0) return;
    setIsImporting(true);
    setResult(null);
    setProblem(null);
    try {
      setResult(await emailReceiptsApi.mailbox.import(files));
      setFiles([]);
      if (inputRef.current) inputRef.current.value = "";
    } catch (error) {
      const message = getErrorMessage(error, t("failed"));
      setProblem(message);
      toast.error(message);
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Card padding="md" as="section" aria-labelledby={`${guideId}-title`}>
      <div className="space-y-4">
        <div>
          <h3
            id={`${guideId}-title`}
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {t("title")}
          </h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t("description")}
          </p>
        </div>

        <div className="space-y-2">
          <label
            htmlFor={`${guideId}-file`}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t("fileLabel")}
          </label>
          <input
            id={`${guideId}-file`}
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={handleChange}
            disabled={isImporting}
            className="block w-full cursor-pointer text-sm text-gray-500 file:mr-4 file:cursor-pointer file:rounded file:border-0 file:bg-blue-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100 dark:text-gray-400 dark:file:bg-blue-900/30 dark:file:text-blue-300 dark:hover:file:bg-blue-900/50"
          />
          {files.length > 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t("selected", { count: count(files.length) })}
            </p>
          )}
        </div>

        <Button
          variant="primary"
          isLoading={isImporting}
          disabled={files.length === 0}
          onClick={() => void handleImport()}
        >
          {t("button")}
        </Button>

        {problem && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {problem}
          </p>
        )}

        {result && (
          <div role="status" className="space-y-2 text-sm">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">
              {t("result.heading")}
            </h4>
            <ul className="space-y-1">
              {result.files.map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className={
                    file.error
                      ? "text-red-700 dark:text-red-400"
                      : "text-gray-700 dark:text-gray-300"
                  }
                >
                  {file.error
                    ? t(`result.errors.${file.error}`, { name: file.name })
                    : t("result.file", {
                        name: file.name,
                        stored: count(file.stored),
                        duplicates: count(file.duplicates),
                        skipped: count(file.skipped),
                      })}
                  {file.ignoredEntries > 0 && (
                    <span className="block text-gray-600 dark:text-gray-400">
                      {t("result.ignored", {
                        name: file.name,
                        count: count(file.ignoredEntries),
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {result.truncated > 0 && (
              <p className="text-amber-700 dark:text-amber-400">
                {t("result.truncated", { count: count(result.truncated) })}
              </p>
            )}
            <p className="text-gray-700 dark:text-gray-300">
              {t("result.summary", { processed: count(result.processed) })}
            </p>
            {result.busy && (
              <p className="text-amber-700 dark:text-amber-400">
                {t("result.busy")}
              </p>
            )}
          </div>
        )}

        <div className="border-t border-gray-200 pt-3 dark:border-gray-700">
          <button
            type="button"
            aria-expanded={guideOpen}
            aria-controls={`${guideId}-guide`}
            onClick={() => setGuideOpen((open) => !open)}
            className="flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={`h-4 w-4 transition-transform motion-reduce:transition-none ${guideOpen ? "rotate-180" : ""}`}
            />
            {t("guide.toggle")}
          </button>
          {guideOpen && (
            <div
              id={`${guideId}-guide`}
              className="mt-3 space-y-4 text-sm text-gray-700 dark:text-gray-300"
            >
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.gmailLabel.title")}
                </h4>
                <Steps
                  items={(["step1", "step2", "step3", "step4"] as const).map(
                    (k) => t(`guide.gmailLabel.${k}`),
                  )}
                />
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.gmailOne.title")}
                </h4>
                <Steps
                  items={(["step1", "step2", "step3"] as const).map((k) =>
                    t(`guide.gmailOne.${k}`),
                  )}
                />
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.imap.title")}
                </h4>
                <Steps
                  items={(["step1", "step2", "step3", "step4"] as const).map(
                    (k) => t(`guide.imap.${k}`),
                  )}
                />
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.outlook.title")}
                </h4>
                <p>{t("guide.outlook.body")}</p>
              </section>
              <section>
                <h4 className="font-medium text-gray-900 dark:text-gray-100">
                  {t("guide.apple.title")}
                </h4>
                <Steps
                  items={(["step1", "step2"] as const).map((k) =>
                    t(`guide.apple.${k}`),
                  )}
                />
              </section>
              <p className="text-gray-600 dark:text-gray-400">
                {t("guide.tip")}
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
