import { TabBar } from "@ygo/mobile";
import { router, usePathname } from "expo-router";
import { useSyncExternalStore } from "react";
import { access } from "../api";
import { tabAt, tabPaths, type TabKey, tabsFor } from "../lib/shop-tabs";
import { strings } from "../strings";
import { ClipboardList, Ellipsis, Package, Receipt, Truck } from "./icons";

const icons = { orders: ClipboardList, bill: Receipt, stock: Package, deliveries: Truck, more: Ellipsis };

/** The Shopkeeper tab bar (#550): on the five tab routes of a shop that answers orders, chosen by the saved role and deliver flag. */
export function ShopTabs() {
  useSyncExternalStore(access.subscribe, access.get);
  const active = tabAt(usePathname());
  const keys = tabsFor({ answersOrders: access.answersOrders(), role: access.role(), canDeliver: access.canDeliver() });
  if (!keys || !active) return null;
  return <TabBar tabs={keys.map((key) => ({ key, label: strings.tabs[key], icon: icons[key] }))} active={active} onSelect={(key) => { if (key !== active) router.replace(tabPaths[key as TabKey]); }} />;
}
