import { Global, Module } from "@nestjs/common";

import { EVENT_BUS } from "./event-bus.interface";
import { MemoryEventBus } from "./memory-event-bus";

/**
 * Binds the active `EventBus`.
 *
 * `@Global()` and imported only by `AppModule`, the shape `DemoModeModule`
 * uses: the bus is reached from the relay, and later from anything else that
 * needs to wake a waiter, and a module edge from each of those would be a
 * require cycle waiting to happen (`module-graph.spec.ts` fails one without a
 * `forwardRef`).
 *
 * The factory has one branch today and returns `MemoryEventBus` unconditionally.
 * Task R6 adds the `CLUSTER_MODE=multi` arm that returns `RedisEventBus`; the
 * token exists now so consumers can be written against it before then.
 */
@Global()
@Module({
  providers: [
    MemoryEventBus,
    {
      provide: EVENT_BUS,
      useFactory: (memory: MemoryEventBus) => memory,
      inject: [MemoryEventBus],
    },
  ],
  exports: [EVENT_BUS],
})
export class EventBusModule {}
