import { Tag } from "../tags/entities/tag.entity";
import { createScopedDbMocks, scopedDbMockModule } from "./scoped-db-testing";

describe("scoped-db-testing harness", () => {
  describe("scopedDbMockModule()", () => {
    it("delegates withScopedDb to dataSource.transaction with the callback", async () => {
      const { withScopedDb } = scopedDbMockModule();
      const manager = { marker: true };
      const dataSource = {
        transaction: jest.fn(async (fn: (m: unknown) => unknown) =>
          fn(manager),
        ),
      };
      const fn = jest.fn().mockResolvedValue("result");

      const result = await withScopedDb(dataSource, fn);

      expect(result).toBe("result");
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(manager);
    });
  });

  describe("createScopedDbMocks()", () => {
    it("routes getRepository to the registered mock repository", () => {
      const tagRepo = { find: jest.fn() };
      const { manager } = createScopedDbMocks([[Tag, tagRepo]]);

      expect(manager.getRepository(Tag)).toBe(tagRepo);
    });

    it("throws a named error for an unregistered entity class", () => {
      const { manager } = createScopedDbMocks();

      expect(() => manager.getRepository(Tag)).toThrow(
        'no mock repository registered for entity "Tag"',
      );
    });

    it("names non-class entity targets in the error too", () => {
      const { manager } = createScopedDbMocks();

      expect(() => manager.getRepository("tags")).toThrow(
        'no mock repository registered for entity "tags"',
      );
    });

    it("dataSource.transaction runs the callback with the mock manager", async () => {
      const { manager, dataSource } = createScopedDbMocks();
      manager.findOne.mockResolvedValue({ id: "row-1" });

      const result = await dataSource.transaction(async (m: typeof manager) =>
        m.findOne(),
      );

      expect(result).toEqual({ id: "row-1" });
      expect(manager.findOne).toHaveBeenCalledTimes(1);
    });
  });
});
