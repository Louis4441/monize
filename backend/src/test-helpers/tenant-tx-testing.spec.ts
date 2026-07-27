import { Tag } from "../tags/entities/tag.entity";
import { createTenantTxMocks, tenantTxMockModule } from "./tenant-tx-testing";

describe("tenant-tx-testing harness", () => {
  describe("tenantTxMockModule()", () => {
    it("delegates tenantTx to dataSource.transaction with the callback", async () => {
      const { tenantTx } = tenantTxMockModule();
      const manager = { marker: true };
      const dataSource = {
        transaction: jest.fn(async (fn: (m: unknown) => unknown) =>
          fn(manager),
        ),
      };
      const fn = jest.fn().mockResolvedValue("result");

      const result = await tenantTx(dataSource, fn);

      expect(result).toBe("result");
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(manager);
    });
  });

  describe("createTenantTxMocks()", () => {
    it("routes getRepository to the registered mock repository", () => {
      const tagRepo = { find: jest.fn() };
      const { manager } = createTenantTxMocks([[Tag, tagRepo]]);

      expect(manager.getRepository(Tag)).toBe(tagRepo);
    });

    it("throws a named error for an unregistered entity class", () => {
      const { manager } = createTenantTxMocks();

      expect(() => manager.getRepository(Tag)).toThrow(
        'no mock repository registered for entity "Tag"',
      );
    });

    it("names non-class entity targets in the error too", () => {
      const { manager } = createTenantTxMocks();

      expect(() => manager.getRepository("tags")).toThrow(
        'no mock repository registered for entity "tags"',
      );
    });

    it("dataSource.transaction runs the callback with the mock manager", async () => {
      const { manager, dataSource } = createTenantTxMocks();
      manager.findOne.mockResolvedValue({ id: "row-1" });

      const result = await dataSource.transaction(async (m: typeof manager) =>
        m.findOne(),
      );

      expect(result).toEqual({ id: "row-1" });
      expect(manager.findOne).toHaveBeenCalledTimes(1);
    });
  });
});
