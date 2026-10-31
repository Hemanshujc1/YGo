import type { LiveBlocker, LiveCheck, ShopState } from "@ygo/contracts";
import { strings } from "../strings";

/** S18's five steps in order (design system: step tracker). */
export const STEPS = ["draft", "submitted", "under_review", "approved", "live"] as const;
export type Step = (typeof STEPS)[number];
export type Mark = "done" | "current" | "later";

/** Each step with where it stands for a shop in `state`: done before it, current at it, later after it. A Live shop has every step done (#363). */
export function steps(state: ShopState): { step: Step; mark: Mark }[] {
  // A ShopState missing from STEPS fails the typecheck here, so no state can mark every step "later".
  const at = (state === "live" || state === "suspended" || state === "closed") ? STEPS.length : STEPS.indexOf(state);
  return STEPS.map((step, index) => ({ step, mark: index < at ? "done" : index === at ? "current" : "later" }));
}

/** The steps the Owner takes on S14, each a button to its screen; YGo clears the rest. */
const ownSteps: Partial<Record<LiveBlocker, "/agreement" | "/hours">> = { hours: "/hours", agreement: "/agreement" };

/** S14's "Waiting for" list on an Approved shop (#363), in the server's order; `href` is set on the Owner's own steps (#371). */
export function waiting(check: LiveCheck): { blocker: LiveBlocker; line: string; href: "/agreement" | "/hours" | null }[] {
  return check.blockers.map((blocker) => ({ blocker, line: strings.shopSetup.waiting.blockers[blocker], href: ownSteps[blocker] ?? null }));
}
