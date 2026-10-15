import { describe, it, expect, vi, beforeEach } from "vitest";
import toast from "react-hot-toast";
import { render, screen, fireEvent, act } from "@/test/render";
import {
  MailboxImportCard,
  MAX_IMPORT_FILES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_TOTAL_BYTES,
} from "./MailboxImportCard";
import type { EmailReceiptImportResult } from "@/types/email-receipts";

const api = vi.hoisted(() => ({ importFiles: vi.fn() }));
vi.mock("@/lib/email-receipts-api", () => ({
  emailReceiptsApi: { mailbox: { import: api.importFiles } },
}));
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function result(
  overrides: Partial<EmailReceiptImportResult> = {},
): EmailReceiptImportResult {
  return {
    files: [
      {
        name: "a.mbox",
        format: "mbox",
        messages: 5,
        stored: 3,
        duplicates: 1,
        skipped: 1,
        ignoredEntries: 0,
        error: null,
      },
    ],
    truncated: 0,
    processed: 3,
    busy: false,
    ...overrides,
  };
}

function file(name: string, size = 10) {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

async function pick(files: File[]) {
  await act(async () => {
    fireEvent.change(
      screen.getByLabelText("Email files (.eml, .mbox, .msg or .zip)"),
      {
        target: { files },
      },
    );
  });
}

async function importNow() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
  });
  await act(async () => {});
}

describe("MailboxImportCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains the import and keeps files without an extension selectable", () => {
    render(<MailboxImportCard />);
    expect(
      screen.getByRole("heading", { name: "Import archived emails" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/keeps the sender and the purchase date/),
    ).toBeInTheDocument();
    const input = screen.getByLabelText(
      "Email files (.eml, .mbox, .msg or .zip)",
    ) as HTMLInputElement;
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain(".eml");
    expect(input.accept).toContain("application/mbox");
    expect(input.accept).toContain(".zip");
    expect(input.accept).toContain(".msg");
  });

  it("keeps Import disabled until files are selected", async () => {
    render(<MailboxImportCard />);
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    await pick([file("a.mbox")]);
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    expect(screen.getByText("Selected: 1")).toBeInTheDocument();
  });

  it("uploads the selected files and lists the result per file", async () => {
    api.importFiles.mockResolvedValue(
      result({
        files: [
          {
            name: "a.mbox",
            format: "mbox",
            messages: 5,
            stored: 3,
            duplicates: 1,
            skipped: 1,
            ignoredEntries: 0,
            error: null,
          },
          {
            name: "b.eml",
            format: "eml",
            messages: 1,
            stored: 1,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 0,
            error: null,
          },
        ],
        processed: 4,
      }),
    );
    render(<MailboxImportCard />);
    const a = file("a.mbox");
    const b = file("b.eml");
    await pick([a, b]);
    await importNow();
    expect(api.importFiles).toHaveBeenCalledWith([a, b]);
    expect(
      screen.getByText("a.mbox: 3 stored, 1 duplicates, 1 skipped"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("b.eml: 1 stored, 0 duplicates, 0 skipped"),
    ).toBeInTheDocument();
    expect(screen.getByText("4 emails processed.")).toBeInTheDocument();
    expect(screen.queryByText(/not read because/)).not.toBeInTheDocument();
    expect(screen.queryByText(/being read right now/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it.each([
    ["invalid_archive", "x.zip: the ZIP file is damaged or cannot be read."],
    [
      "archive_too_large",
      "x.zip: the ZIP file expands to more than 100 MB. Split it, or upload the .mbox file inside.",
    ],
    [
      "unsupported_format",
      "x.pdf: this format is not supported. Supported formats are .eml, .mbox, .msg and .zip.",
    ],
    ["empty", "x.eml: the file holds no emails."],
  ] as const)("shows the refusal for %s", async (code, text) => {
    const name = text.split(":")[0];
    api.importFiles.mockResolvedValue(
      result({
        files: [
          {
            name,
            format: null,
            messages: 0,
            stored: 0,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 0,
            error: code,
          },
        ],
      }),
    );
    render(<MailboxImportCard />);
    await pick([file(name)]);
    await importNow();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("reports the ZIP entries that were not mail files, and only then", async () => {
    api.importFiles.mockResolvedValue(
      result({
        files: [
          {
            name: "takeout.zip",
            format: "zip",
            messages: 4,
            stored: 4,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 3,
            error: null,
          },
          {
            name: "b.msg",
            format: "msg",
            messages: 1,
            stored: 1,
            duplicates: 0,
            skipped: 0,
            ignoredEntries: 0,
            error: null,
          },
        ],
      }),
    );
    render(<MailboxImportCard />);
    await pick([file("takeout.zip"), file("b.msg")]);
    await importNow();
    expect(
      screen.getByText(
        "takeout.zip: 3 other files in the archive were skipped.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/other files in the archive/)).toHaveLength(1);
  });

  it("says how many messages were left out by the cap", async () => {
    api.importFiles.mockResolvedValue(result({ truncated: 1200 }));
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(
      screen.getByText(/1,200 messages were not read/),
    ).toBeInTheDocument();
  });

  it("says the emails wait for the next read when the mailbox is busy", async () => {
    api.importFiles.mockResolvedValue(result({ busy: true, processed: 0 }));
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(
      screen.getByText(
        "The mailbox is being read right now. The imported emails will be processed at the next read.",
      ),
    ).toBeInTheDocument();
  });

  it("refuses more than the file limit without a request", async () => {
    render(<MailboxImportCard />);
    await pick(
      Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => file(`m${i}.eml`)),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Select at most 20 files per import.",
    );
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(api.importFiles).not.toHaveBeenCalled();
  });

  it("accepts exactly the file limit, the size limit and the total limit", async () => {
    render(<MailboxImportCard />);
    const rest = MAX_IMPORT_TOTAL_BYTES - 3 * MAX_IMPORT_FILE_BYTES;
    await pick([
      ...Array.from({ length: 3 }, (_, i) =>
        file(`big${i}.mbox`, MAX_IMPORT_FILE_BYTES),
      ),
      file("rest.mbox", rest),
      ...Array.from({ length: MAX_IMPORT_FILES - 4 }, (_, i) =>
        file(`m${i}.eml`, 0),
      ),
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
  });

  it("refuses files that together pass the total limit, without a request", async () => {
    render(<MailboxImportCard />);
    await pick([
      ...Array.from({ length: 3 }, (_, i) =>
        file(`big${i}.mbox`, MAX_IMPORT_FILE_BYTES),
      ),
      file("rest.mbox", MAX_IMPORT_TOTAL_BYTES - 3 * MAX_IMPORT_FILE_BYTES + 1),
    ]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /together are larger than/,
    );
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(api.importFiles).not.toHaveBeenCalled();
  });

  it("refuses a file over the size limit and names it", async () => {
    render(<MailboxImportCard />);
    await pick([file("ok.eml"), file("big.mbox", MAX_IMPORT_FILE_BYTES + 1)]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /big\.mbox is larger than/,
    );
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(api.importFiles).not.toHaveBeenCalled();
  });

  it("shows the server message and a toast when the request fails", async () => {
    api.importFiles.mockRejectedValue({
      response: { data: { message: "File too large" } },
    });
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByRole("alert")).toHaveTextContent("File too large");
    expect(toast.error).toHaveBeenCalledWith("File too large");
    expect(screen.queryByText(/emails processed/)).not.toBeInTheDocument();
  });

  it("falls back to a translated message when the error has none", async () => {
    api.importFiles.mockRejectedValue({ response: {} });
    render(<MailboxImportCard />);
    await pick([file("a.mbox")]);
    await importNow();
    expect(screen.getByRole("alert")).toHaveTextContent("The import failed");
  });

  it("opens and closes the export guide", async () => {
    render(<MailboxImportCard />);
    const toggle = screen.getByRole("button", {
      name: "How to export emails from your provider",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Gmail: one email")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Gmail: all emails with a label"),
    ).toBeInTheDocument();
    expect(screen.getByText("Gmail: one email")).toBeInTheDocument();
    expect(
      screen.getByText(/ImportExportTools NG, then export/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Upload the downloaded .zip file as it is/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Outlook writes .msg files/)).toBeInTheDocument();
    expect(screen.getByText("Outlook desktop")).toBeInTheDocument();
    expect(screen.getByText("Apple Mail")).toBeInTheDocument();
    expect(
      screen.getByText(/forwarding emails with a script loses/),
    ).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByText("Gmail: one email")).not.toBeInTheDocument();
  });
});
