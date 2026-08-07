import { PostgresAdapter, makeAdapterFactory } from "./postgres.adapter";

describe("PostgresAdapter", () => {
  function makeAdapter(model = "AccessToken") {
    const repo = {
      upsert: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue(repo),
    } as any;
    const adapter = new PostgresAdapter(model, dataSource);
    return { adapter, repo };
  }

  it("upserts a payload with the right grant_id for grantable models", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");

    await adapter.upsert(
      "tok-1",
      { grantId: "grant-9", aud: "https://example/mcp" } as any,
      3600,
    );

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [entity, options] = repo.upsert.mock.calls[0];
    expect(entity.id).toBe("tok-1");
    expect(entity.model).toBe("AccessToken");
    expect(entity.grantId).toBe("grant-9");
    expect(entity.expiresAt).toBeInstanceOf(Date);
    expect(options).toEqual({ conflictPaths: ["id", "model"] });
  });

  it("does not store grant_id for non-grantable models", async () => {
    const { adapter, repo } = makeAdapter("Client");

    await adapter.upsert(
      "client-1",
      { grantId: "should-be-ignored" } as any,
      0,
    );

    const [entity] = repo.upsert.mock.calls[0];
    expect(entity.grantId).toBeNull();
    expect(entity.expiresAt).toBeNull();
  });

  it("returns undefined for expired payloads", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");
    repo.findOne.mockResolvedValue({
      id: "tok",
      model: "AccessToken",
      payload: { foo: "bar" },
      expiresAt: new Date(Date.now() - 1000),
      consumedAt: null,
    });

    const result = await adapter.find("tok");

    expect(result).toBeUndefined();
  });

  it("returns the payload for non-expired rows and adds consumed claim when consumed", async () => {
    const { adapter, repo } = makeAdapter("AuthorizationCode");
    const consumedAt = new Date();
    repo.findOne.mockResolvedValue({
      id: "code",
      model: "AuthorizationCode",
      payload: { foo: "bar" },
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt,
    });

    const result = await adapter.find("code");

    expect(result).toMatchObject({
      foo: "bar",
      consumed: Math.floor(consumedAt.getTime() / 1000),
    });
  });

  it("revokeByGrantId deletes by grant_id only (not scoped to model)", async () => {
    const { adapter, repo } = makeAdapter("AccessToken");

    await adapter.revokeByGrantId("grant-9");

    expect(repo.delete).toHaveBeenCalledWith({ grantId: "grant-9" });
  });

  it("destroy scopes deletion to the (id, model) tuple", async () => {
    const { adapter, repo } = makeAdapter("Session");

    await adapter.destroy("sess-1");

    expect(repo.delete).toHaveBeenCalledWith({
      id: "sess-1",
      model: "Session",
    });
  });

  it("consume sets consumed_at without removing the row", async () => {
    const { adapter, repo } = makeAdapter("AuthorizationCode");

    await adapter.consume("code-1");

    expect(repo.update).toHaveBeenCalledWith(
      { id: "code-1", model: "AuthorizationCode" },
      expect.objectContaining({ consumedAt: expect.any(Date) }),
    );
  });

  /**
   * The two lookups that were never covered. Both matter to the RLS exemption
   * argument in `docs/row-level-security-contract.md` section 3, which rests on
   * every adapter query being keyed by an opaque provider identifier: a lookup
   * that forgot to scope by `model` would read one artifact class's row while
   * claiming to serve another.
   */
  describe("secondary lookups stay scoped to their model", () => {
    it("findByUserCode keys on (userCode, model)", async () => {
      const { adapter, repo } = makeAdapter("DeviceCode");
      repo.findOne.mockResolvedValue({
        id: "dev-1",
        model: "DeviceCode",
        payload: { foo: "bar" },
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });

      await expect(adapter.findByUserCode("WDJB-MJHT")).resolves.toMatchObject({
        foo: "bar",
      });
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { userCode: "WDJB-MJHT", model: "DeviceCode" },
      });
    });

    it("findByUid keys on (uid, model)", async () => {
      const { adapter, repo } = makeAdapter("Session");
      repo.findOne.mockResolvedValue({
        id: "sess-1",
        model: "Session",
        payload: { foo: "bar" },
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      });

      await expect(adapter.findByUid("uid-1")).resolves.toMatchObject({
        foo: "bar",
      });
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { uid: "uid-1", model: "Session" },
      });
    });

    it("returns undefined rather than a payload when the row is missing", async () => {
      // "Not found" and "found but expired" are the same answer to the caller,
      // and neither may be an empty payload object -- oidc-provider treats a
      // returned object as a live artifact.
      const { adapter, repo } = makeAdapter("Session");
      repo.findOne.mockResolvedValue(null);

      await expect(adapter.findByUid("nope")).resolves.toBeUndefined();
      await expect(adapter.findByUserCode("nope")).resolves.toBeUndefined();
    });
  });

  it("makeAdapterFactory builds one adapter per model over a shared DataSource", () => {
    // The provider calls the factory once per artifact class; each instance must
    // carry its own model or `destroy`/`consume` would cross artifact classes.
    const dataSource = { getRepository: jest.fn() } as any;
    const factory = makeAdapterFactory(dataSource);

    const accessToken = factory("AccessToken");
    const session = factory("Session");

    expect(accessToken).toBeInstanceOf(PostgresAdapter);
    expect(session).toBeInstanceOf(PostgresAdapter);
    expect(accessToken).not.toBe(session);
    expect((accessToken as any).model).toBe("AccessToken");
    expect((session as any).model).toBe("Session");
    expect((accessToken as any).dataSource).toBe(dataSource);
  });
});
