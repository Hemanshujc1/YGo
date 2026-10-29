import type { LiveBlocker, LiveCheck, ShopState } from "@ygo/contracts";
import { strings } from "../strings";

/** S18's five steps in order (design system: step tracker). */
export const STEPS = ["draft", "submitted", "under_review", "approved", "live"] as const;
export type Step = (typeof STEPS)[number];
export type Mark = "done" | "current" | "later";

/** Each step with where it stands for a shop in `state`: done before it, current at it, later after it. A Live shop has every step done (#363). */
export function steps(state: ShopState): { step: Step; mark: Mark }[] {
  // A ShopState missing from STEPS fails the typecheck here, so no state can mark every step "later".
  const at = state === "live" ? STEPS.length : STEPS.indexOf(state);
  return STEPS.map((step, index) => ({ step, mark: index < at ? "done" : index === at ? "current" : "later" }));
}

/**
 * S14's "Waiting for" list on an Approved shop (#363), in the server's order.
 * Accepting the agreement is the one step the Owner takes, so it is `own`
 * and shows as a button; YGo clears the rest.
 */
export function waiting(check: LiveCheck): { blocker: LiveBlocker; line: string; own: boolean }[] {
  return check.blockers.map((blocker) => ({ blocker, line: strings.shopSetup.waiting.blockers[blocker], own: blocker === "agreement" }));
}
