import { Test, TestingModule } from "@nestjs/testing";
import { ScheduledInvestmentTransactionsController } from "./scheduled-investment-transactions.controller";
import { ScheduledInvestmentTransactionsService } from "./scheduled-investment-transactions.service";

describe("ScheduledInvestmentTransactionsController", () => {
  let controller: ScheduledInvestmentTransactionsController;
  let mockService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findUpcoming: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      post: jest.fn(),
      skip: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScheduledInvestmentTransactionsController],
      providers: [
        {
          provide: ScheduledInvestmentTransactionsService,
          useValue: mockService,
        },
      ],
    }).compile();

    controller = module.get(ScheduledInvestmentTransactionsController);
  });

  it("create() delegates to service", async () => {
    const dto = { name: "VOO DCA" } as any;
    mockService.create.mockResolvedValue({ id: "s-1" });
    const r = await controller.create(mockReq, dto);
    expect(mockService.create).toHaveBeenCalledWith("user-1", dto);
    expect(r).toEqual({ id: "s-1" });
  });

  it("findAll() delegates to service", async () => {
    mockService.findAll.mockResolvedValue([]);
    await controller.findAll(mockReq);
    expect(mockService.findAll).toHaveBeenCalledWith("user-1");
  });

  it("findUpcoming() defaults days to 30", async () => {
    mockService.findUpcoming.mockResolvedValue([]);
    await controller.findUpcoming(mockReq, undefined);
    expect(mockService.findUpcoming).toHaveBeenCalledWith("user-1", 30);
  });

  it("findUpcoming() forwards explicit days", async () => {
    mockService.findUpcoming.mockResolvedValue([]);
    await controller.findUpcoming(mockReq, 7);
    expect(mockService.findUpcoming).toHaveBeenCalledWith("user-1", 7);
  });

  it("findOne() delegates to service", async () => {
    mockService.findOne.mockResolvedValue({ id: "s-1" });
    await controller.findOne(mockReq, "s-1");
    expect(mockService.findOne).toHaveBeenCalledWith("user-1", "s-1");
  });

  it("update() delegates to service", async () => {
    const dto = { name: "Updated" } as any;
    mockService.update.mockResolvedValue({ id: "s-1" });
    await controller.update(mockReq, "s-1", dto);
    expect(mockService.update).toHaveBeenCalledWith("user-1", "s-1", dto);
  });

  it("remove() delegates to service", async () => {
    mockService.remove.mockResolvedValue(undefined);
    await controller.remove(mockReq, "s-1");
    expect(mockService.remove).toHaveBeenCalledWith("user-1", "s-1");
  });

  it("post() delegates to service", async () => {
    const dto = { transactionDate: "2026-05-10" };
    mockService.post.mockResolvedValue({ id: "s-1" });
    await controller.post(mockReq, "s-1", dto as any);
    expect(mockService.post).toHaveBeenCalledWith("user-1", "s-1", dto);
  });

  it("skip() delegates to service", async () => {
    mockService.skip.mockResolvedValue({ id: "s-1" });
    await controller.skip(mockReq, "s-1");
    expect(mockService.skip).toHaveBeenCalledWith("user-1", "s-1");
  });
});
