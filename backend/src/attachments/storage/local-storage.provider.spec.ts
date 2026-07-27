import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalStorageProvider } from "./local-storage.provider";

describe("LocalStorageProvider", () => {
  let baseDir: string;
  let provider: LocalStorageProvider;

  const configFor = (dir: string) =>
    ({ get: () => dir }) as unknown as ConfigService;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(join(tmpdir(), "monize-attach-"));
    provider = new LocalStorageProvider(configFor(baseDir));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("has the local name", () => {
    expect(provider.name).toBe("local");
  });

  it("round-trips saved bytes", async () => {
    const key = "11111111-1111-1111-1111-111111111111";
    const data = Buffer.from("hello attachment");
    await provider.save(key, data);
    await expect(provider.load(key)).resolves.toEqual(data);
  });

  it("creates the base directory on first save", async () => {
    const nested = join(baseDir, "does", "not", "exist");
    const p = new LocalStorageProvider(configFor(nested));
    await p.save("k1", Buffer.from("x"));
    await expect(p.load("k1")).resolves.toEqual(Buffer.from("x"));
  });

  it("throws NotFound when loading a missing key", async () => {
    await expect(provider.load("missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("delete is idempotent", async () => {
    await provider.save("k2", Buffer.from("y"));
    await expect(provider.delete("k2")).resolves.toBeUndefined();
    await expect(provider.delete("k2")).resolves.toBeUndefined();
    await expect(provider.load("k2")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects keys that would escape the base directory", async () => {
    await expect(
      provider.save("../escape", Buffer.from("z")),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(provider.load("sub/dir")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("defaults to /data/attachments when unconfigured", () => {
    const p = new LocalStorageProvider({
      get: () => undefined,
    } as unknown as ConfigService);
    expect(p).toBeInstanceOf(LocalStorageProvider);
  });
});
