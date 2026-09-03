import {
  ClientCapabilitiesSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  confirmWrite,
  hasScope,
  requireScope,
  safeToolError,
  toolError,
  toolResult,
} from "./mcp-context";

function fakeServer(opts: { capabilities?: unknown; elicit?: jest.Mock }): any {
  return {
    server: {
      getClientCapabilities: jest.fn().mockReturnValue(opts.capabilities),
      elicitInput: opts.elicit ?? jest.fn(),
    },
  };
}

describe("mcp-context", () => {
  describe("hasScope", () => {
    it("should return true when scope is present", () => {
      expect(hasScope("read,write,reports", "read")).toBe(true);
      expect(hasScope("read,write,reports", "write")).toBe(true);
      expect(hasScope("read,write,reports", "reports")).toBe(true);
    });

    it("should return false when scope is missing", () => {
      expect(hasScope("read", "write")).toBe(false);
      expect(hasScope("read,reports", "write")).toBe(false);
    });

    it("should handle single scope", () => {
      expect(hasScope("read", "read")).toBe(true);
    });

    it("should not match partial scope names", () => {
      expect(hasScope("readonly", "read")).toBe(false);
      expect(hasScope("read", "readonly")).toBe(false);
    });
  });

  describe("requireScope", () => {
    it("should return error: false when scope is present", () => {
      const result = requireScope("read,write", "read");
      expect(result.error).toBe(false);
    });

    it("should return error result when scope is missing", () => {
      const result = requireScope("read", "write");
      expect(result.error).toBe(true);
      if (result.error) {
        expect(result.result.isError).toBe(true);
        expect(result.result.content[0].text).toContain("write");
        expect(result.result.content[0].text).toContain("Insufficient scope");
      }
    });

    it("should mention the required scope in the error message", () => {
      const result = requireScope("read", "reports");
      if (result.error) {
        expect(result.result.content[0].text).toContain('"reports"');
      }
    });
  });

  describe("toolError", () => {
    it("should return an error response with message", () => {
      const result = toolError("Something went wrong");
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Something went wrong");
      expect(result.content[0].text).toContain("Error:");
    });
  });

  describe("safeToolError", () => {
    it("should pass through message for a 404 NotFoundException", () => {
      const notFoundErr = {
        getStatus: () => 404,
        getResponse: () => ({ message: "Category not found" }),
      };
      const result = safeToolError(notFoundErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Category not found");
    });

    it("should pass through message for a 400 BadRequestException", () => {
      const badRequestErr = {
        getStatus: () => 400,
        getResponse: () => ({ message: "Invalid account ID" }),
      };
      const result = safeToolError(badRequestErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid account ID");
    });

    it("should return generic message for a plain Error without getStatus", () => {
      const plainErr = new Error("Something broke internally");
      const result = safeToolError(plainErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "An error occurred while processing your request",
      );
      expect(result.content[0].text).not.toContain(
        "Something broke internally",
      );
    });

    it("should return generic message for null or undefined", () => {
      const nullResult = safeToolError(null);
      expect(nullResult.isError).toBe(true);
      expect(nullResult.content[0].text).toContain(
        "An error occurred while processing your request",
      );

      const undefinedResult = safeToolError(undefined);
      expect(undefinedResult.isError).toBe(true);
      expect(undefinedResult.content[0].text).toContain(
        "An error occurred while processing your request",
      );
    });

    it("should return generic message for a 500 InternalServerError", () => {
      const serverErr = {
        getStatus: () => 500,
        getResponse: () => ({ message: "Internal server error" }),
      };
      const result = safeToolError(serverErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "An error occurred while processing your request",
      );
      expect(result.content[0].text).not.toContain("Internal server error");
    });
  });

  describe("toolResult", () => {
    it("returns the payload once, as structured content", () => {
      // Not twice. Every tool declares an outputSchema, so structuredContent is
      // what the SDK validates and what a client reads; the pretty-printed text
      // block beside it made a model pay for the same answer a second time.
      const data = { accounts: [{ id: "a1", name: "Checking" }] };
      const result = toolResult(data);
      expect((result as any).isError).toBeUndefined();
      expect(result.content).toEqual([]);
      expect(result.structuredContent as any).toEqual(data);
    });

    it("keeps the text block for errors, which carry no structured content", () => {
      const result = toolError("Unknown account");
      expect(result.content[0].text).toBe("Error: Unknown account");
      expect((result as any).structuredContent).toBeUndefined();
      expect(result.isError).toBe(true);
    });

    it("handles arrays and primitives through structured content alone", () => {
      expect(toolResult([1, 2, 3]).structuredContent).toEqual({
        items: [1, 2, 3],
      });
      expect(toolResult(null).structuredContent).toEqual({ value: null });
      expect(toolResult(42).structuredContent).toEqual({ value: 42 });
      expect(toolResult("hello").structuredContent).toEqual({ value: "hello" });
    });

    describe("structuredContent", () => {
      it("passes an object payload through unchanged", () => {
        const data = { netWorth: 1000, totalAccounts: 2 };
        const result = toolResult(data);
        expect(result.structuredContent).toEqual(data);
      });

      it("wraps a bare array under 'items' (structured content must be an object)", () => {
        const result = toolResult([{ id: "a1" }, { id: "a2" }]);
        expect(result.structuredContent).toEqual({
          items: [{ id: "a1" }, { id: "a2" }],
        });
      });

      it("wraps a primitive payload under 'value'", () => {
        expect(toolResult(42).structuredContent).toEqual({ value: 42 });
        expect(toolResult(null).structuredContent).toEqual({ value: null });
      });
    });
  });

  describe("confirmWrite", () => {
    const caps = { elicitation: { form: {} } };

    it("returns 'accepted' when the user accepts the elicitation", async () => {
      const elicit = jest.fn().mockResolvedValue({ action: "accept" });
      const server = fakeServer({ capabilities: caps, elicit });
      await expect(confirmWrite(server, "Confirm?", "req-1")).resolves.toBe(
        "accepted",
      );
      expect(elicit).toHaveBeenCalledWith(
        {
          message: "Confirm?",
          requestedSchema: { type: "object", properties: {} },
        },
        { timeout: expect.any(Number), relatedRequestId: "req-1" },
      );
    });

    it("threads the tool call's request id so the elicitation rides its POST SSE stream", async () => {
      const elicit = jest.fn().mockResolvedValue({ action: "accept" });
      const server = fakeServer({ capabilities: caps, elicit });
      await confirmWrite(server, "Confirm?", 42);
      expect(elicit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ relatedRequestId: 42 }),
      );
    });

    it("returns 'declined' when the user declines or cancels", async () => {
      const declineServer = fakeServer({
        capabilities: caps,
        elicit: jest.fn().mockResolvedValue({ action: "decline" }),
      });
      await expect(
        confirmWrite(declineServer, "Confirm?", "req-1"),
      ).resolves.toBe("declined");

      const cancelServer = fakeServer({
        capabilities: caps,
        elicit: jest.fn().mockResolvedValue({ action: "cancel" }),
      });
      await expect(
        confirmWrite(cancelServer, "Confirm?", "req-1"),
      ).resolves.toBe("declined");
    });

    it("returns 'unsupported' without eliciting when the client lacks the capability", async () => {
      const elicit = jest.fn();
      const server = fakeServer({ capabilities: {}, elicit });
      await expect(confirmWrite(server, "Confirm?", "req-1")).resolves.toBe(
        "unsupported",
      );
      expect(elicit).not.toHaveBeenCalled();
    });

    it("returns 'unsupported' when capabilities are undefined", async () => {
      const server = fakeServer({ capabilities: undefined });
      await expect(confirmWrite(server, "Confirm?", "req-1")).resolves.toBe(
        "unsupported",
      );
    });

    it("returns 'declined' (never silently proceeds) when a supported dialog fails in an unaccounted-for way", async () => {
      const elicit = jest.fn().mockRejectedValue(new Error("boom"));
      const server = fakeServer({ capabilities: caps, elicit });
      await expect(confirmWrite(server, "Confirm?", "req-1")).resolves.toBe(
        "declined",
      );
    });

    // The regression these guard: `@modelcontextprotocol/sdk` >= 1.23 rewrites a
    // bare `{"elicitation":{}}` into `{"elicitation":{"form":{}}}`, so the
    // capability pre-check stopped separating a client that shows dialogs from
    // one that answers -32601 or never answers at all. Every such client then
    // looked form-capable, its non-answer was read as the user saying no, and
    // every write through Claude was refused (or hung past the client's own
    // tool deadline). Only observed behaviour can tell them apart.
    describe("a client that answers for itself", () => {
      it("pins the SDK normalization the old capability check relied on", () => {
        expect(ClientCapabilitiesSchema.parse({ elicitation: {} })).toEqual({
          elicitation: { form: {} },
        });
      });

      it.each([
        ["method not found", ErrorCode.MethodNotFound],
        ["request timeout", ErrorCode.RequestTimeout],
        ["connection closed", ErrorCode.ConnectionClosed],
        ["invalid request", ErrorCode.InvalidRequest],
        ["invalid params", ErrorCode.InvalidParams],
        ["parse error", ErrorCode.ParseError],
      ])("returns 'unsupported' on %s", async (_label, code) => {
        const elicit = jest
          .fn()
          .mockRejectedValue(new McpError(code, "client answered for itself"));
        const server = fakeServer({ capabilities: caps, elicit });
        await expect(confirmWrite(server, "Confirm?", "req-1")).resolves.toBe(
          "unsupported",
        );
      });

      it("stops asking it for the rest of the session", async () => {
        const elicit = jest
          .fn()
          .mockRejectedValue(
            new McpError(ErrorCode.MethodNotFound, "Method not found"),
          );
        const server = fakeServer({ capabilities: caps, elicit });
        await confirmWrite(server, "Confirm?", "req-1");
        await expect(confirmWrite(server, "Confirm?", "req-2")).resolves.toBe(
          "unsupported",
        );
        expect(elicit).toHaveBeenCalledTimes(1);
      });

      it("keeps the session's memory to itself", async () => {
        const silent = fakeServer({
          capabilities: caps,
          elicit: jest
            .fn()
            .mockRejectedValue(
              new McpError(ErrorCode.MethodNotFound, "Method not found"),
            ),
        });
        await confirmWrite(silent, "Confirm?", "req-1");

        const capable = fakeServer({
          capabilities: caps,
          elicit: jest.fn().mockResolvedValue({ action: "decline" }),
        });
        await expect(confirmWrite(capable, "Confirm?", "req-1")).resolves.toBe(
          "declined",
        );
      });
    });

    describe("a client that has already shown a dialog", () => {
      it("refuses a later unanswered one rather than writing", async () => {
        const elicit = jest
          .fn()
          .mockResolvedValueOnce({ action: "accept" })
          .mockRejectedValueOnce(
            McpError.fromError(ErrorCode.RequestTimeout, "Request timed out"),
          );
        const server = fakeServer({ capabilities: caps, elicit });
        await expect(confirmWrite(server, "Confirm?", "req-1")).resolves.toBe(
          "accepted",
        );
        await expect(confirmWrite(server, "Confirm?", "req-2")).resolves.toBe(
          "declined",
        );
      });

      it("is not demoted by that failure", async () => {
        const elicit = jest
          .fn()
          .mockResolvedValueOnce({ action: "accept" })
          .mockRejectedValueOnce(
            McpError.fromError(ErrorCode.RequestTimeout, "Request timed out"),
          )
          .mockResolvedValueOnce({ action: "accept" });
        const server = fakeServer({ capabilities: caps, elicit });
        await confirmWrite(server, "Confirm?", "req-1");
        await confirmWrite(server, "Confirm?", "req-2");
        await expect(confirmWrite(server, "Confirm?", "req-3")).resolves.toBe(
          "accepted",
        );
        expect(elicit).toHaveBeenCalledTimes(3);
      });
    });

    // The wait has to end before the client abandons the tool call that is
    // waiting on it, or an unanswerable dialog produces no result at all --
    // which is how a five-minute wait surfaced as an opaque client-side
    // "timed out after 60s" with no write and no explanation.
    it("waits less than the shortest client tool deadline", async () => {
      const elicit = jest.fn().mockResolvedValue({ action: "accept" });
      const server = fakeServer({ capabilities: caps, elicit });
      await confirmWrite(server, "Confirm?", "req-1");
      const { timeout } = elicit.mock.calls[0][1];
      expect(timeout).toBeGreaterThan(20_000);
      expect(timeout).toBeLessThan(60_000);
    });
  });
});
