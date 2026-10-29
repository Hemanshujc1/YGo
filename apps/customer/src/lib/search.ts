import type { ApiResult } from "@ygo/api-client";
import { SearchQuery, type SearchProduct, type SearchResponse, type SearchShop } from "@ygo/contracts";
import { strings } from "../strings";

const typedText = SearchQuery.shape.q;
/** The longest search the server takes (#398). */
export const searchMaxLength = typedText.maxLength ?? undefined;
/** The pause after the last letter before searching (owner's answer 11 on #49). */
export const searchDelay = 300;

/** The text to search for, trimmed, or null until the server's rule takes it: from 2 characters (owner's answer 11 on #49). */
export function searchText(typed: string): string | null {
  const parsed = typedText.safeParse(typed);
  return parsed.success ? parsed.data : null;
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
