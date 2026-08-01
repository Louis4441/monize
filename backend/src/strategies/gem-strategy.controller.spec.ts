import { Test, TestingModule } from "@nestjs/testing";
import { GemStrategyController } from "./gem-strategy.controller";
import { GemStrategyService } from "./gem-strategy.service";
import { GemStrategyReportView } from "./gem-report.types";

describe("GemStrategyController", () => {
  let controller: GemStrategyController;
  let service: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };
  const report = { warnings: [] } as unknown as GemStrategyReportView;

  beforeEach(async () => {
    service = {
      getReport: jest.fn().mockResolvedValue(report),
      updateConfig: jest.fn().mockResolvedValue(report),
      markExecuted: jest.fn().mockResolvedValue(report),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GemStrategyController],
      providers: [{ provide: GemStrategyService, useValue: service }],
    }).compile();

    controller = module.get<GemStrategyController>(GemStrategyController);
  });

  it("reads the report for the authenticated user", async () => {
    await expect(controller.getReport(req, { range: "3Y" })).resolves.toBe(
      report,
    );
    expect(service.getReport).toHaveBeenCalledWith("user-1", "3Y", undefined);
  });

  it("defaults the chart range to one year", async () => {
    await controller.getReport(req, {});
    expect(service.getReport).toHaveBeenCalledWith("user-1", "1Y", undefined);
  });

  it("updates the configuration for the authenticated user", async () => {
    const dto = { cadence: "QUARTERLY" as const };
    await controller.updateConfig(req, dto, {});
    expect(service.updateConfig).toHaveBeenCalledWith(
      "user-1",
      dto,
      "1Y",
      undefined,
    );
  });

  it("marks a signal executed and passes the range on", async () => {
    await controller.markExecuted(req, "sig-1", { range: "6M" });
    expect(service.markExecuted).toHaveBeenCalledWith(
      "user-1",
      "sig-1",
      "6M",
      undefined,
    );
  });

  it("never takes the user id from the request payload", async () => {
    await controller.getReport({ user: { id: "user-2" } }, {});
    expect(service.getReport).toHaveBeenCalledWith("user-2", "1Y", undefined);
  });
});
