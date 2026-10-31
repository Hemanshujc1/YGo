import { trimDecimal } from "@ygo/format";
import { strings } from "../strings";

/**
 * "1 kg left · 2 kg held for orders" on Listings and Stock (#436); the held part only when an accepted order holds some.
 * `held` is missing on a Stock item saved before #436 until the next pull rewrites it.
 */
export function stockLine(left: string, held: string | undefined, unit: string): string {
  const line = strings.stockLine.left(`${trimDecimal(left)} ${unit}`);
  return held && Number(held) > 0 ? `${line} · ${strings.stockLine.held(`${trimDecimal(held)} ${unit}`)}` : line;
}
