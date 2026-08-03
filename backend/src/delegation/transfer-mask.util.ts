/**
 * Transfer counterpart masking, shared by the HTTP interceptor and the
 * response paths that bypass it (CSV export, AI/MCP reads).
 *
 * A transfer row leaks its counterpart through the eager `linkedTransaction`
 * relation (a full Account load, balance included) and through the auto payee
 * name ("Transfer to/from <account>"). Whenever the reader lacks READ on the
 * counterpart's account, both are rewritten to the "Hidden account" stub.
 */

export const HIDDEN_ACCOUNT_NAME = "Hidden account";

/** Rewrite the auto payee tail ("Transfer to/from <name>") to the stub. */
export function maskAutoPayeeName(payeeName: string): string {
  const m = /^(Transfer (?:to|from) ).+/.exec(payeeName);
  return m ? `${m[1]}${HIDDEN_ACCOUNT_NAME}` : payeeName;
}

/**
 * True when some row in the payload is a transfer whose linked leg belongs to
 * a different user -- the only case a non-acting reader can need masking.
 * This is the interceptor's load-bearing fast path: it must stay a pure
 * payload scan so ordinary list requests never pay a grants query.
 */
export function payloadHasCrossOwnerTransfer(payload: unknown): boolean {
  return someTransaction(payload, (t) => {
    const linked = t.linkedTransaction as Record<string, unknown> | undefined;
    return (
      t.isTransfer === true &&
      !!linked &&
      typeof linked === "object" &&
      linked.userId !== undefined &&
      linked.userId !== t.userId
    );
  });
}

/**
 * Mask every transfer row in `payload` whose counterpart account is not in
 * `readable` (the reader's own account ids plus their can_read grants).
 * Mutates the payload in place, mirroring the interceptor's historic
 * behavior.
 */
export function maskTransactionsAgainst(
  readable: Set<string>,
  payload: unknown,
): void {
  someTransaction(payload, (t) => {
    maskTransactionRow(t, readable);
    return false;
  });
}

/** Walk the payload shapes a transactions response can take. */
function someTransaction(
  payload: unknown,
  fn: (t: Record<string, any>) => boolean,
): boolean {
  const visit = (tx: unknown): boolean =>
    !!tx && typeof tx === "object" && fn(tx as Record<string, any>);

  if (Array.isArray(payload)) {
    return payload.some(visit);
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      return (obj.data as unknown[]).some(visit);
    }
    return visit(payload);
  }
  return false;
}

function maskTransactionRow(
  t: Record<string, any>,
  readable: Set<string>,
): void {
  const linked = t.linkedTransaction as Record<string, any> | undefined;
  if (!t.isTransfer || !linked) return;
  const otherAccountId: string | undefined = linked.accountId;
  if (!otherAccountId || readable.has(otherAccountId)) return;

  if (linked.account && typeof linked.account === "object") {
    linked.account = { id: linked.accountId, name: HIDDEN_ACCOUNT_NAME };
  }
  if (typeof linked.accountName === "string") {
    linked.accountName = HIDDEN_ACCOUNT_NAME;
  }
  // The visible row's auto payee name embeds the counterpart account name.
  if (typeof t.payeeName === "string") {
    t.payeeName = maskAutoPayeeName(t.payeeName);
  }
}
