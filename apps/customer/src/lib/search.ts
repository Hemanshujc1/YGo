import type { ApiResult } from "@ygo/api-client";
import type { SearchProduct, SearchResponse, SearchShop } from "@ygo/contracts";
import { strings } from "../strings";

/** The longest search the server takes (#398). */
export const searchMaxLength = 60;
/** The pause after the last letter before searching (owner's answer 11 on #49). */
export const searchDelay = 300;

/** The text to search for, or null below 2 characters (owner's answer 11 on #49). */
export function searchText(typed: string): string | null {
  const text = typed.trim();
  return text.length >= 2 ? text : null;
}

export type SearchState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "results"; shops: SearchShop[] }
  | { kind: "none"; text: string }
  | { kind: "failed"; message: string };

/** C16's state from the server's answer to `text`, or "offline" when none came back. */
export function searchAnswer(text: string, result: ApiResult<SearchResponse> | "offline"): SearchState {
  if (result === "offline") return { kind: "failed", message: strings.area.offline };
  if (!result.ok) return { kind: "failed", message: strings.errors[result.code] };
  return result.data.shops.length ? { kind: "results", shops: result.data.shops } : { kind: "none", text };
}

/** "Onion · Fresho · In stock": no price (owner's answers 13 on #49 and 3 on #398). */
export function productLine(product: SearchProduct): string {
  return [product.name, product.brand, product.inStock ? strings.search.inStock : strings.search.outOfStock].filter(Boolean).join(" · ");
}
