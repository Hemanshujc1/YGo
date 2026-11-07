export type TabKey = "orders" | "bill" | "stock" | "deliveries" | "more";

/** The route each tab opens; the bar shows only on these routes (#550). */
export const tabPaths: Record<TabKey, string> = { orders: "/orders", bill: "/bill", stock: "/stock", deliveries: "/deliveries", more: "/more" };

/**
 * The tabs this phone shows (design system, Navigation; #550): none until the shop answers orders; Deliveries only for the
 * Owner and for Staff who can deliver. It only decides what the phone shows; the server refuses what a role may not do.
 */
export function tabsFor({ answersOrders, role, canDeliver }: { answersOrders: boolean; role: "owner" | "staff" | null; canDeliver: boolean }): TabKey[] | null {
  if (!answersOrders || !role) return null;
  return role === "owner" || canDeliver ? ["orders", "bill", "stock", "deliveries", "more"] : ["orders", "bill", "stock", "more"];
}

/** The tab a route belongs to, null on any other route, where no bar shows. */
export function tabAt(pathname: string): TabKey | null {
  return (Object.keys(tabPaths) as TabKey[]).find((key) => tabPaths[key] === pathname) ?? null;
}
