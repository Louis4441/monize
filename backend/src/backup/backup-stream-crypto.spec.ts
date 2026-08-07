import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
  createBackupEncryptStream,
  decryptFramedBackup,
  FRAME_PLAINTEXT_BYTES,
} from "./backup-stream-crypto";
import {
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
} from "./backup-crypto.util";
import {
  BackupDecryptionError,
  FRAME_LENGTH_BYTES,
  FRAMED_HEADER_LENGTH,
  MAGIC,
  VERSION_FRAMED,
} from "./backup-envelope";

/**
 * The framed container exists so the encrypted export can be written as it is
 * produced (issue #1070). A chunked AEAD is easy to get subtly wrong, so what is
 * tested here is not "it round-trips" but every way a file could be rearranged
 * and still open.
 */
describe("framed backup container", () => {
  const PASSWORD = "correct horse battery staple";

  async function seal(payload: Buffer, password = PASSWORD): Promise<Buffer> {
    const framer = await createBackupEncryptStream(password);
    const chunks: Buffer[] = [];
    framer.on("data", (chunk: Buffer) => chunks.push(chunk));
    await pipeline(Readable.from([payload]), framer);
    return Buffer.concat(chunks);
  }

  /** Frame boundaries as the reader sees them: [start, end) of each frame body. */
  function frames(envelope: Buffer): Array<{ start: number; end: number }> {
    const found: Array<{ start: number; end: number }> = [];
    let offset = FRAMED_HEADER_LENGTH;
    while (offset < envelope.length) {
      const length = envelope.readUInt32BE(offset);
      offset += FRAME_LENGTH_BYTES;
      found.push({ start: offset, end: offset + length });
      offset += length;
    }
    return found;
  }

  it("round-trips a payload smaller than one frame", async () => {
    const payload = Buffer.from("a small backup");
    const envelope = await seal(payload);

    expect(envelope.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(envelope[4]).toBe(VERSION_FRAMED);
    expect(frames(envelope)).toHaveLength(1);
    await expect(decryptFramedBackup(envelope, PASSWORD)).resolves.toEqual(
      payload,
    );
  });

  it("round-trips a payload spanning several frames", async () => {
    // Random rather than repeated bytes: a payload of one character would round
    // trip through a container that dropped or duplicated whole frames.
    const payload = Buffer.alloc(FRAME_PLAINTEXT_BYTES * 2 + 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31) % 251;
    const envelope = await seal(payload);

    expect(frames(envelope).length).toBeGreaterThan(2);
    const opened = await decryptFramedBackup(envelope, PASSWORD);
    expect(opened.equals(payload)).toBe(true);
  });

  it("round-trips an empty payload as one final frame", async () => {
    // A file with no frames has nothing authenticating its end.
    const envelope = await seal(Buffer.alloc(0));

    expect(frames(envelope)).toHaveLength(1);
    await expect(decryptFramedBackup(envelope, PASSWORD)).resolves.toEqual(
      Buffer.alloc(0),
    );
  });

  it("does not accumulate the payload before emitting the first frame", async () => {
    // The whole point: a v1 envelope cannot emit a byte of ciphertext until the
    // last byte of plaintext exists, because one auth tag covers all of it.
    const framer = await createBackupEncryptStream(PASSWORD);
    const seen: Buffer[] = [];
    framer.on("data", (chunk: Buffer) => seen.push(chunk));

    framer.write(Buffer.alloc(FRAME_PLAINTEXT_BYTES + 1, 7));
    await new Promise((resolve) => setImmediate(resolve));

    // Header plus at least one sealed frame, with the stream still open.
    expect(Buffer.concat(seen).length).toBeGreaterThan(FRAME_PLAINTEXT_BYTES);
    framer.destroy();
  });

  it("refuses a wrong password", async () => {
    const envelope = await seal(Buffer.from("secrets"));
    await expect(decryptFramedBackup(envelope, "wrong")).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("refuses a truncated stream", async () => {
    // The attack a naive chunked format gets wrong: drop the tail and the rest
    // still decrypts, so half a backup restores as though it were the whole one.
    const payload = Buffer.alloc(FRAME_PLAINTEXT_BYTES * 2, 3);
    const envelope = await seal(payload);
    const cut = frames(envelope)[0];
    const truncated = envelope.subarray(0, cut.end);

    await expect(decryptFramedBackup(truncated, PASSWORD)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("refuses reordered frames", async () => {
    const payload = Buffer.alloc(FRAME_PLAINTEXT_BYTES * 2, 3);
    const envelope = await seal(payload);
    const [first, second] = frames(envelope);
    const swapped = Buffer.concat([
      envelope.subarray(0, first.start - FRAME_LENGTH_BYTES),
      envelope.subarray(second.start - FRAME_LENGTH_BYTES, second.end),
      envelope.subarray(first.start - FRAME_LENGTH_BYTES, first.end),
      envelope.subarray(second.end),
    ]);

    await expect(decryptFramedBackup(swapped, PASSWORD)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("refuses a frame spliced in from another file under the same password", async () => {
    const a = await seal(Buffer.alloc(FRAME_PLAINTEXT_BYTES * 2, 1));
    const b = await seal(Buffer.alloc(FRAME_PLAINTEXT_BYTES * 2, 2));
    const target = frames(a)[0];
    const donor = frames(b)[0];
    const spliced = Buffer.concat([
      a.subarray(0, target.start - FRAME_LENGTH_BYTES),
      b.subarray(donor.start - FRAME_LENGTH_BYTES, donor.end),
      a.subarray(target.end),
    ]);

    // Same password, different salt and nonce prefix -- and the header is the
    // AAD, so a frame cannot be moved between files even if the keys matched.
    await expect(decryptFramedBackup(spliced, PASSWORD)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("refuses a tampered byte anywhere in a frame", async () => {
    const envelope = await seal(Buffer.alloc(1024, 9));
    const flipped = Buffer.from(envelope);
    flipped[frames(envelope)[0].start] ^= 0xff;

    await expect(decryptFramedBackup(flipped, PASSWORD)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("refuses a tampered header", async () => {
    const envelope = await seal(Buffer.alloc(1024, 9));
    const flipped = Buffer.from(envelope);
    // A byte of the nonce prefix, which is header and therefore AAD.
    flipped[FRAMED_HEADER_LENGTH - 1] ^= 0xff;

    await expect(decryptFramedBackup(flipped, PASSWORD)).rejects.toThrow(
      BackupDecryptionError,
    );
  });

  it("refuses an envelope carrying no frames", async () => {
    const envelope = await seal(Buffer.from("x"));
    await expect(
      decryptFramedBackup(envelope.subarray(0, FRAMED_HEADER_LENGTH), PASSWORD),
    ).rejects.toThrow(/no frames/);
  });

  it("refuses a declared frame length the file cannot satisfy", async () => {
    // A hostile envelope must not be able to ask for an allocation by lying.
    const envelope = await seal(Buffer.from("x"));
    const lying = Buffer.from(envelope);
    lying.writeUInt32BE(0x7fffffff, FRAMED_HEADER_LENGTH);

    await expect(decryptFramedBackup(lying, PASSWORD)).rejects.toThrow(
      /unusable frame size/,
    );
  });

  it("refuses a file that ends inside a frame header", async () => {
    const envelope = await seal(Buffer.from("x"));
    const cut = envelope.subarray(0, FRAMED_HEADER_LENGTH + 2);

    await expect(decryptFramedBackup(cut, PASSWORD)).rejects.toThrow(
      /ends inside a frame header/,
    );
  });
});

describe("envelope version dispatch", () => {
  const PASSWORD = "p";
  const payload = Buffer.from(JSON.stringify({ version: 1 }), "utf-8");

  it("recognises both container versions as encrypted backups", async () => {
    const monolithic = await encryptBackup(payload, PASSWORD);
    const framer = await createBackupEncryptStream(PASSWORD);
    const chunks: Buffer[] = [];
    framer.on("data", (chunk: Buffer) => chunks.push(chunk));
    await pipeline(Readable.from([payload]), framer);

    expect(isEncryptedBackup(monolithic)).toBe(true);
    expect(isEncryptedBackup(Buffer.concat(chunks))).toBe(true);
  });

  it("still opens a monolithic envelope produced before the framed one existed", async () => {
    // Every backup a user already holds is v1. A restore that could not read
    // them would be a data-loss change dressed as an optimisation.
    const monolithic = await encryptBackup(payload, PASSWORD);
    await expect(decryptBackup(monolithic, PASSWORD)).resolves.toEqual(payload);
  });

  it("opens a framed envelope through the same door", async () => {
    const framer = await createBackupEncryptStream(PASSWORD);
    const chunks: Buffer[] = [];
    framer.on("data", (chunk: Buffer) => chunks.push(chunk));
    await pipeline(Readable.from([payload]), framer);

    await expect(
      decryptBackup(Buffer.concat(chunks), PASSWORD),
    ).resolves.toEqual(payload);
  });

  it("rejects a version byte from neither container", async () => {
    const monolithic = await encryptBackup(payload, PASSWORD);
    const future = Buffer.from(monolithic);
    future[MAGIC.length] = 0x7f;

    expect(isEncryptedBackup(future)).toBe(false);
    await expect(decryptBackup(future, PASSWORD)).rejects.toThrow(
      /not in the encrypted Monize format/,
    );
  });
});
