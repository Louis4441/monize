import { Test } from "@nestjs/testing";

import { EventBusModule } from "./event-bus.module";
import { EVENT_BUS, EventBus } from "./event-bus.interface";
import { MemoryEventBus } from "./memory-event-bus";

/**
 * The binding, not the bus. Which implementation the token resolves to is the
 * whole of what this module decides, and it is what task R6 changes -- so the
 * assertion is on `name`, the field an implementation cannot get wrong without
 * saying so.
 */
describe("EventBusModule", () => {
  it("binds EVENT_BUS to the in-process bus", async () => {
    const module = await Test.createTestingModule({
      imports: [EventBusModule],
    }).compile();

    const bus = module.get<EventBus>(EVENT_BUS);
    expect(bus).toBeInstanceOf(MemoryEventBus);
    expect(bus.name).toBe("memory");

    await module.close();
  });

  it("hands every consumer the same instance", async () => {
    const module = await Test.createTestingModule({
      imports: [EventBusModule],
    }).compile();

    // A per-consumer bus would deliver nothing across two of them, which is the
    // failure the relay would hit first and diagnose last.
    expect(module.get<EventBus>(EVENT_BUS)).toBe(module.get(MemoryEventBus));

    await module.close();
  });
});
