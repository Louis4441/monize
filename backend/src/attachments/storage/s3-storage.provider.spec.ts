import { NotImplementedException } from "@nestjs/common";
import { S3StorageProvider } from "./s3-storage.provider";

describe("S3StorageProvider", () => {
  const provider = new S3StorageProvider();

  it("has the s3 name", () => {
    expect(provider.name).toBe("s3");
  });

  it("refuses save until implemented", async () => {
    await expect(provider.save("k", Buffer.from("x"))).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });

  it("refuses load until implemented", async () => {
    await expect(provider.load("k")).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });

  it("refuses delete until implemented", async () => {
    await expect(provider.delete("k")).rejects.toBeInstanceOf(
      NotImplementedException,
    );
  });
});
