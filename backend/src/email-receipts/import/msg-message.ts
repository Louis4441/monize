import { createHash } from "crypto";
import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";

/**
 * Outlook `.msg` to a minimal RFC 5322 message, so a `.msg` goes through the
 * same row builder (`buildReceiptRow`, hence `extractMailText`) as every other
 * message. The original transport headers are used when the file carries them
 * (PidTagTransportMessageHeaders), field by field, else From, Date, Subject and
 * Message-ID come from the file's properties. Every header value is one line
 * (no CR or LF survives, so a value cannot inject a header) and non-ASCII text
 * is RFC 2047 encoded; bodies are base64 UTF-8.
 */

const WANTED_HEADERS = ["from", "date", "message-id", "subject"] as const;
type WantedHeader = (typeof WANTED_HEADERS)[number];
type HeaderValues = Partial<Record<WantedHeader, string>>;

/** One line: line breaks become spaces, other control characters go. */
function oneLine(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x0d || code === 0x09) out += " ";
    else if (code > 0x1f && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim();
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7e) return false;
  }
  return true;
}

/** An unstructured header value: ASCII as it is, else RFC 2047 `B` words. */
function encodeHeaderText(value: string): string {
  const line = oneLine(value);
  if (isAscii(line)) return line;
  // 45 bytes of UTF-8 per word keeps each encoded word under 75 characters;
  // words are cut on code points, never inside one.
  const words: string[] = [];
  let current = "";
  for (const char of line) {
    if (Buffer.byteLength(current + char, "utf8") > 45) {
      words.push(current);
      current = "";
    }
    current += char;
  }
  if (current) words.push(current);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`,
    )
    .join(" ");
}

/** The first of the four wanted headers, unfolded, from a transport header block. */
function parseTransportHeaders(block: string): HeaderValues {
  const found: HeaderValues = {};
  let name: string | null = null;
  let value = "";
  const flush = (): void => {
    if (name === null) return;
    const key = name as WantedHeader;
    if (found[key] === undefined) found[key] = oneLine(value);
  };
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === "") break;
    if ((line.startsWith(" ") || line.startsWith("\t")) && name !== null) {
      value += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    const lower = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
    name = (WANTED_HEADERS as readonly string[]).includes(lower) ? lower : null;
    value = name === null ? "" : line.slice(colon + 1).trim();
  }
  flush();
  return found;
}

function fromProperties(data: FieldsData): HeaderValues {
  const out: HeaderValues = {};
  const email = oneLine(data.senderEmail ?? "").replace(/[\s<>"]/g, "");
  if (email) {
    const name = oneLine(data.senderName ?? "");
    const display = !name
      ? ""
      : isAscii(name)
        ? `"${name.replace(/(["\\])/g, "\\$1")}" `
        : `${encodeHeaderText(name)} `;
    out.from = `${display}<${email}>`;
  }
  for (const raw of [data.clientSubmitTime, data.messageDeliveryTime]) {
    const date = raw ? new Date(raw) : null;
    if (date && !Number.isNaN(date.getTime())) {
      out.date = date.toUTCString();
      break;
    }
  }
  if (data.subject) out.subject = encodeHeaderText(data.subject);
  const id = oneLine(data.messageId ?? "").replace(/[\s<>]/g, "");
  if (id) out["message-id"] = `<${id}>`;
  return out;
}

function base64Lines(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return (encoded.match(/.{1,76}/g) ?? []).join("\r\n");
}

function htmlOf(data: FieldsData): string | null {
  if (typeof data.bodyHtml === "string" && data.bodyHtml) return data.bodyHtml;
  if (data.html && data.html.length > 0) {
    return Buffer.from(data.html).toString("utf8");
  }
  return null;
}

/**
 * The RFC 5322 source of a parsed `.msg`. A header taken from the transport
 * headers is passed through `oneLine` and a non-ASCII one is encoded; a
 * transport value that is already an encoded word stays as it is.
 */
export function buildRfc822FromMsg(data: FieldsData): Buffer {
  const fromTransport =
    typeof data.headers === "string" ? parseTransportHeaders(data.headers) : {};
  const fromProps = fromProperties(data);
  const header = (name: WantedHeader): string | undefined => {
    const value = fromTransport[name];
    if (value) return isAscii(value) ? value : encodeHeaderText(value);
    return fromProps[name];
  };
  const lines: string[] = [];
  for (const [label, name] of [
    ["From", "from"],
    ["Date", "date"],
    ["Message-ID", "message-id"],
    ["Subject", "subject"],
  ] as const) {
    const value = header(name);
    if (value) lines.push(`${label}: ${value}`);
  }
  lines.push("MIME-Version: 1.0");

  const text = typeof data.body === "string" ? data.body : "";
  const html = htmlOf(data);
  const part = (type: string, content: string) =>
    [
      `Content-Type: ${type}; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(content),
    ].join("\r\n");

  let body: string;
  if (html !== null && text) {
    const boundary = `monize-${createHash("sha256")
      .update(text)
      .update(html)
      .digest("hex")
      .slice(0, 24)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    // The empty first element is the blank line that ends the header block.
    body = [
      "",
      `--${boundary}`,
      part("text/plain", text),
      `--${boundary}`,
      part("text/html", html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else if (html !== null) {
    body = part("text/html", html);
  } else {
    body = part("text/plain", text);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n${body}\r\n`, "utf8");
}

/**
 * The RFC 5322 source of a `.msg` file, or null when it cannot be read (not an
 * OLE file, damaged, or a message class msgreader reports an error for).
 */
export function readMsgAsRfc822(bytes: Buffer): Buffer | null {
  try {
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const data = new MsgReader(arrayBuffer).getFileData();
    if (data.error || data.dataType !== "msg") return null;
    return buildRfc822FromMsg(data);
  } catch {
    return null;
  }
}
