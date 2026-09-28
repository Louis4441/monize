import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { TransactionRulesController } from "./transaction-rules.controller";
import { TransactionRulesService } from "./transaction-rules.service";
import { ALLOW_DELEGATE_KEY } from "../delegation/decorators/delegate-access.decorator";
import { CreateTransactionRuleDto } from "./dto/create-transaction-rule.dto";
import { UpdateTransactionRuleDto } from "./dto/update-transaction-rule.dto";

describe("TransactionRulesController", () => {
  let controller: TransactionRulesController;
  let service: Record<string, jest.Mock>;
  const req = { user: { id: "user-1" } };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      get: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setEnabled: jest.fn(),
      remove: jest.fn(),
      reorder: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [TransactionRulesController],
      providers: [{ provide: TransactionRulesService, useValue: service }],
    }).compile();
    controller = module.get(TransactionRulesController);
  });

  it("lists with the JWT user", async () => {
    service.list.mockResolvedValue([{ id: "r1" }]);

    await expect(controller.findAll(req)).resolves.toEqual([{ id: "r1" }]);
    expect(service.list).toHaveBeenCalledWith("user-1");
  });

  it("gets one rule", async () => {
    service.get.mockResolvedValue({ id: "r1" });

    await expect(controller.findOne(req, "r1")).resolves.toEqual({ id: "r1" });
    expect(service.get).toHaveBeenCalledWith("user-1", "r1");
  });

  it("creates with the JWT user", async () => {
    const dto = { name: "n" } as CreateTransactionRuleDto;
    service.create.mockResolvedValue({ id: "r1" });

    await controller.create(req, dto);

    expect(service.create).toHaveBeenCalledWith("user-1", dto);
  });

  it("updates by id", async () => {
    const dto = { revision: 2 } as UpdateTransactionRuleDto;

    await controller.update(req, "r1", dto);

    expect(service.update).toHaveBeenCalledWith("user-1", "r1", dto);
  });

  it("toggles enabled", async () => {
    await controller.setEnabled(req, "r1", { enabled: false });

    expect(service.setEnabled).toHaveBeenCalledWith("user-1", "r1", false);
  });

  it("deletes by id", async () => {
    await controller.remove(req, "r1");

    expect(service.remove).toHaveBeenCalledWith("user-1", "r1");
  });

  it("reorders with the ids", async () => {
    await controller.reorder(req, { ids: ["r2", "r1"] });

    expect(service.reorder).toHaveBeenCalledWith("user-1", ["r2", "r1"]);
  });

  describe("route table", () => {
    const proto = TransactionRulesController.prototype;
    const route = (name: keyof TransactionRulesController) => ({
      path: Reflect.getMetadata(PATH_METADATA, proto[name]),
      method: Reflect.getMetadata(METHOD_METADATA, proto[name]),
    });

    it("maps the seven endpoints", () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, TransactionRulesController),
      ).toBe("transaction-rules");
      expect(route("findAll")).toEqual({
        path: "/",
        method: RequestMethod.GET,
      });
      expect(route("create")).toEqual({
        path: "/",
        method: RequestMethod.POST,
      });
      expect(route("reorder")).toEqual({
        path: "reorder",
        method: RequestMethod.PUT,
      });
      expect(route("findOne")).toEqual({
        path: ":id",
        method: RequestMethod.GET,
      });
      expect(route("update")).toEqual({
        path: ":id",
        method: RequestMethod.PATCH,
      });
      expect(route("setEnabled")).toEqual({
        path: ":id/enabled",
        method: RequestMethod.PATCH,
      });
      expect(route("remove")).toEqual({
        path: ":id",
        method: RequestMethod.DELETE,
      });
    });

    it("registers reorder before the :id routes so it is not read as a UUID", () => {
      const order = Object.getOwnPropertyNames(proto);
      expect(order.indexOf("reorder")).toBeLessThan(order.indexOf("findOne"));
    });

    it("is under the JWT guard and refuses a delegate session", () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, TransactionRulesController),
      ).toHaveLength(1);
      // OwnerOnly() sets ALLOW_DELEGATE_KEY to false on the class, and no
      // method overrides it with @AllowDelegate().
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, TransactionRulesController),
      ).toBe(false);
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === "constructor") continue;
        expect(
          Reflect.getMetadata(ALLOW_DELEGATE_KEY, (proto as never)[name]),
        ).not.toBe(true);
      }
    });
  });
});
