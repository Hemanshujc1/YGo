import type { OrderStatus } from "@ygo/contracts";
import { strings } from "../strings";

type Treatment = keyof typeof strings.orderTreatments;

/** Who has to act, by status, in the shop's view (design system section 6, ORD-1): Admin watches the shop's side of an order. */
const treatment: Record<OrderStatus, Treatment> = {
  placed: "needs_you", scheduled_pending_review: "needs_you", awaiting_customer_confirm: "waiting",
  accepted: "in_progress", scheduled_confirmed: "in_progress", preparing: "in_progress", ready: "in_progress", out_for_delivery: "in_progress", arrived: "in_progress",
  delivered: "completed", picked_up: "completed",
  rejected_by_shop: "ended", expired: "ended", not_collected: "ended", cancelled_by_customer: "ended", cancelled_by_shop: "ended", delivery_failed: "ended",
};

const look: Record<Treatment, { box: string; icon: string }> = {
  needs_you: { box: "bg-accent text-on-accent", icon: "🔔︎" },
  waiting: { box: "bg-info-subtle text-on-info-subtle", icon: "◔" },
  in_progress: { box: "bg-primary-subtle text-on-primary-subtle", icon: "➜" },
  completed: { box: "bg-success-subtle text-on-success-subtle", icon: "✓" },
  ended: { box: "border border-border-strong", icon: "✕" },
};

/** The status as the five-treatment pill: icon and label, so the treatment never rests on colour alone. */
export function OrderStatusPill({ status }: { status: OrderStatus }) {
  const { box, icon } = look[treatment[status]];
  return <span className={`inline-flex h-7 items-center gap-1 rounded-full px-3 text-small-label font-medium ${box}`} title={strings.orderTreatments[treatment[status]]}>
    <span aria-hidden="true">{icon}</span>{strings.orderStatuses[status]}</span>;
}
