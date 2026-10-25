import type { ShopState } from "@ygo/contracts";

/** S18's five steps in order (design system: step tracker). Live joins `ShopState` in #46. */
export const STEPS = ["draft", "submitted", "under_review", "approved", "live"] as const;
export type Step = (typeof STEPS)[number];
export type Mark = "done" | "current" | "later";

/** Each step with where it stands for a shop in `state`: done before it, current at it, later after it. */
export function steps(state: ShopState): { step: Step; mark: Mark }[] {
  // A ShopState missing from STEPS fails the typecheck here, so no state can mark every step "later".
  const at = STEPS.indexOf(state);
  return STEPS.map((step, index) => ({ step, mark: index < at ? "done" : index === at ? "current" : "later" }));
}
