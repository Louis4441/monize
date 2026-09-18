import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CLUSTER_MODE, ClusterMode } from "../common/cluster/cluster-mode";
import {
  PG_LISTENER,
  PgListener,
} from "../common/cluster/pg-listener.provider";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  let controller: HealthController;
  let mockDataSource: Partial<DataSource>;
  let listener: { isConnected: jest.Mock } | null;

  const build = async (
    mode: ClusterMode,
    connected: boolean | null,
  ): Promise<void> => {
    mockDataSource = { query: jest.fn() };
    listener =
      connected === null ? null : { isConnected: jest.fn(() => connected) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DataSource, useValue: mockDataSource },
        { provide: CLUSTER_MODE, useValue: mode },
        {
          provide: PG_LISTENER,
          useValue: listener as unknown as PgListener | null,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  };

  const databaseUp = () =>
    (mockDataSource.query as jest.Mock).mockResolvedValue([{ "?column?": 1 }]);
  const databaseDown = () =>
    (mockDataSource.query as jest.Mock).mockRejectedValue(
      new Error("connection failed"),
    );

  describe("in CLUSTER_MODE=single", () => {
    beforeEach(async () => {
      await build("single", null);
    });

    describe("check()", () => {
      it("returns ok status when database is healthy", async () => {
        databaseUp();

        const result = await controller.check();

        expect(result.status).toBe("ok");
        expect(result.checks.database).toBe("healthy");
        expect(result.timestamp).toBeDefined();
      });

      it("returns degraded status when database is unhealthy", async () => {
        databaseDown();

        const result = await controller.check();

        expect(result.status).toBe("degraded");
        expect(result.checks.database).toBe("unhealthy");
      });

      it("omits the event bus, which does not exist here", async () => {
        databaseUp();

        const result = await controller.check();

        // A key that is always "healthy" invites a dashboard to watch a
        // constant, and a key that said "unhealthy" would report the absence of
        // a cross-replica channel as a fault.
        expect(result.checks).not.toHaveProperty("eventBus");
      });
    });

    describe("live()", () => {
      it("always returns ok", () => {
        const result = controller.live();
        expect(result).toEqual({ status: "ok" });
      });
    });

    describe("ready()", () => {
      it("returns ok when database is healthy", async () => {
        databaseUp();

        const result = await controller.ready();
        expect(result).toEqual({ status: "ok" });
      });

      it("throws ServiceUnavailableException when database is unhealthy", async () => {
        databaseDown();

        await expect(controller.ready()).rejects.toThrow("Service not ready");
      });
    });
  });

  describe("in CLUSTER_MODE=multi", () => {
    describe("with the notification channel live", () => {
      beforeEach(async () => {
        await build("multi", true);
      });

      it("is ready", async () => {
        databaseUp();

        await expect(controller.ready()).resolves.toEqual({ status: "ok" });
      });

      it("reports the event bus as healthy", async () => {
        databaseUp();

        const result = await controller.check();

        expect(result.status).toBe("ok");
        expect(result.checks.eventBus).toBe("healthy");
      });
    });

    describe("with the notification channel down", () => {
      beforeEach(async () => {
        await build("multi", false);
      });

      it("leaves the load balancer even though the database is fine", async () => {
        databaseUp();

        // This replica answers requests but cannot be woken: an SSE stream it
        // holds advances only on the slow poll, and a relay turn answered on
        // another replica waits out that timer. One replica out is cheaper than
        // a conversation that looks hung.
        await expect(controller.ready()).rejects.toThrow("Service not ready");
      });

      it("reports degraded with the cause named", async () => {
        databaseUp();

        const result = await controller.check();

        expect(result.status).toBe("degraded");
        expect(result.checks.database).toBe("healthy");
        expect(result.checks.eventBus).toBe("unhealthy");
      });

      it("recovers when the connection returns", async () => {
        databaseUp();
        await expect(controller.ready()).rejects.toThrow("Service not ready");

        listener!.isConnected.mockReturnValue(true);

        await expect(controller.ready()).resolves.toEqual({ status: "ok" });
      });
    });

    it("treats a missing listener as down rather than as absent", async () => {
      // multi with no listener bound is a wiring defect, not a single-replica
      // deployment; serving traffic on it would be the silent-wake-up failure
      // the mode exists to prevent.
      await build("multi", null);
      databaseUp();

      await expect(controller.ready()).rejects.toThrow("Service not ready");
      expect((await controller.check()).checks.eventBus).toBe("unhealthy");
    });

    it("does not consult the listener before the database", async () => {
      await build("multi", true);
      databaseDown();

      await expect(controller.ready()).rejects.toThrow("Service not ready");
      // The database is the more fundamental failure and the cheaper check to
      // report; asking the listener after it is refused costs nothing, but the
      // refusal must not depend on the listener's answer.
      expect(listener!.isConnected).not.toHaveBeenCalled();
    });
  });
});
