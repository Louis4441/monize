import { BOND_ENGINE_PRICE_SOURCE } from "../bonds/bond-price-source";
import { BackupData } from "./backup-format";

/**
 * The file's price rows without the bond engine's rows of the given securities:
 * they were computed from an instrument the security is no longer linked to,
 * nothing would ever recompute or remove them, and a security priced by a stale
 * engine looks like a valid price (INV-BOND-005). The input is returned as is
 * when there is nothing to remove or it is not a list.
 */
export function withoutEnginePrices(
  prices: BackupData["security_prices"],
  securityIds: ReadonlySet<string>,
): BackupData["security_prices"] {
  if (securityIds.size === 0 || !Array.isArray(prices)) return prices;
  return prices.filter(
    (p) =>
      !(
        p.source === BOND_ENGINE_PRICE_SOURCE &&
        typeof p.security_id === "string" &&
        securityIds.has(p.security_id)
      ),
  );
}
