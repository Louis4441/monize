import {
  AI_PROVIDER_KEY_PLAINTEXT_FIELD,
  AiKeyCrypto,
  exportAiProviderKey,
  restoreAiProviderKey,
} from "./ai-provider-key-transport";

/**
 * A crypto double that behaves like the real one in the way that matters: a
 * ciphertext is tied to the instance that produced it, and reading it anywhere
 * else raises rather than returning plausible bytes. AES-GCM authenticates, so
 * that is not a simplification -- it is the property the whole design rests on.
 */
function instance(masterKey: string, configured = true): AiKeyCrypto {
  return {
    isConfigured: () => configured,
    encrypt: (plaintext) => `${masterKey}:${plaintext}`,
    decrypt: (ciphertext) => {
      if (!ciphertext.startsWith(`${masterKey}:`)) {
        throw new Error("Unsupported state or unable to authenticate data");
      }
      return ciphertext.slice(masterKey.length + 1);
    },
  };
}

const SOURCE = instance("instance-a");
const TARGET = instance("instance-b");

function providerRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "cfg-1",
    user_id: "user-1",
    provider: "anthropic",
    priority: 0,
    api_key_enc: SOURCE.encrypt("sk-ant-live"),
    ...overrides,
  };
}

describe("exportAiProviderKey", () => {
  it("replaces readable ciphertext with the plaintext key", () => {
    const { row, outcome } = exportAiProviderKey(providerRow(), SOURCE);

    expect(outcome).toBe("decrypted");
    expect(row[AI_PROVIDER_KEY_PLAINTEXT_FIELD]).toBe("sk-ant-live");
    // Nulled, not carried alongside: two representations of one secret is one
    // more than the restore can be asked to choose between, and the stale one is
    // unreadable on the target anyway.
    expect(row.api_key_enc).toBeNull();
  });

  it("leaves the rest of the row alone", () => {
    const { row } = exportAiProviderKey(
      providerRow({ display_name: "My Claude", model: "claude-sonnet-4" }),
      SOURCE,
    );

    expect(row.display_name).toBe("My Claude");
    expect(row.model).toBe("claude-sonnet-4");
    expect(row.provider).toBe("anthropic");
  });

  it("does not mutate the row it was given", () => {
    const original = providerRow();
    const snapshot = { ...original };

    exportAiProviderKey(original, SOURCE);

    expect(original).toEqual(snapshot);
  });

  it("reports a row with no key rather than inventing one", () => {
    for (const empty of [null, undefined, ""]) {
      const { row, outcome } = exportAiProviderKey(
        providerRow({ api_key_enc: empty }),
        SOURCE,
      );
      expect(outcome).toBe("no-key");
      expect(row[AI_PROVIDER_KEY_PLAINTEXT_FIELD]).toBeUndefined();
    }
  });

  it("carries ciphertext it cannot read verbatim, and says so", () => {
    // Already restored from somewhere else, or encrypted before the variable was
    // rotated. Blanking it would destroy the one thing that still works: a
    // restore back onto the instance that produced it.
    const foreign = providerRow({ api_key_enc: TARGET.encrypt("sk-other") });

    const { row, outcome } = exportAiProviderKey(foreign, SOURCE);

    expect(outcome).toBe("left-encrypted");
    expect(row.api_key_enc).toBe(foreign.api_key_enc);
    expect(row[AI_PROVIDER_KEY_PLAINTEXT_FIELD]).toBeUndefined();
  });

  it("carries ciphertext verbatim when no encryption key is configured", () => {
    const unconfigured = instance("instance-a", false);

    const { row, outcome } = exportAiProviderKey(providerRow(), unconfigured);

    expect(outcome).toBe("left-encrypted");
    expect(row.api_key_enc).toBe(providerRow().api_key_enc);
  });
});

describe("restoreAiProviderKey", () => {
  it("re-encrypts the plaintext under the receiving instance's key", () => {
    const exported = exportAiProviderKey(providerRow(), SOURCE).row;

    const { row, outcome } = restoreAiProviderKey(exported, TARGET);

    expect(outcome).toBe("re-encrypted");
    expect(TARGET.decrypt(row.api_key_enc as string)).toBe("sk-ant-live");
    // The plaintext must not survive onto anything the insert path can see.
    expect(row[AI_PROVIDER_KEY_PLAINTEXT_FIELD]).toBeUndefined();
  });

  it("completes the round trip between two instances", () => {
    // The whole point: a key configured on A is usable on B without the user
    // re-entering it, which exporting the ciphertext could never achieve.
    const exported = exportAiProviderKey(providerRow(), SOURCE).row;
    const restored = restoreAiProviderKey(exported, TARGET).row;

    expect(TARGET.decrypt(restored.api_key_enc as string)).toBe("sk-ant-live");
    expect(() => SOURCE.decrypt(restored.api_key_enc as string)).toThrow();
  });

  it("drops a plaintext key it has nowhere to put, rather than storing it bare", () => {
    // `api_key_enc` is fed to `decrypt` by everything that builds a provider, so
    // a plaintext value parked there throws on every call while looking like a
    // configured key. Losing it is the better failure, and it is reported.
    const exported = exportAiProviderKey(providerRow(), SOURCE).row;

    const { row, outcome } = restoreAiProviderKey(
      exported,
      instance("instance-b", false),
    );

    expect(outcome).toBe("dropped-unencryptable");
    expect(row.api_key_enc).toBeNull();
    expect(row[AI_PROVIDER_KEY_PLAINTEXT_FIELD]).toBeUndefined();
  });

  it("restores an older artifact's ciphertext untouched", () => {
    // Written before keys travelled in plaintext. It still restores, and still
    // only works on the instance that produced it -- which is what the caller
    // reports.
    const legacy = providerRow();

    const { row, outcome } = restoreAiProviderKey(legacy, TARGET);

    expect(outcome).toBe("kept-foreign-ciphertext");
    expect(row.api_key_enc).toBe(legacy.api_key_enc);
  });

  it("reports a keyless row as keyless, not as a loss", () => {
    // Ollama and the MCP relay have no credential. Counting them would send the
    // user hunting for a key that never existed.
    const { outcome } = restoreAiProviderKey(
      providerRow({ api_key_enc: null }),
      TARGET,
    );

    expect(outcome).toBe("no-key");
  });

  it("strips the plaintext field even when it is present but empty", () => {
    const { row, outcome } = restoreAiProviderKey(
      { ...providerRow({ api_key_enc: null }), api_key_plaintext: "" },
      TARGET,
    );

    expect(row).not.toHaveProperty(AI_PROVIDER_KEY_PLAINTEXT_FIELD);
    expect(outcome).toBe("no-key");
  });

  it("does not mutate the row it was given", () => {
    const exported = exportAiProviderKey(providerRow(), SOURCE).row;
    const snapshot = { ...exported };

    restoreAiProviderKey(exported, TARGET);

    expect(exported).toEqual(snapshot);
  });
});
