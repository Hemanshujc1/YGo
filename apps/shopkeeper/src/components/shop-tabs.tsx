import { TabBar } from "@ygo/mobile";
import { router, usePathname } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Keyboard } from "react-native";
import { access, session } from "../api";
import { tabAt, tabPaths, type TabKey, tabsFor } from "../lib/shop-tabs";
import { strings } from "../strings";
import { ClipboardList, Ellipsis, Package, Receipt, Truck } from "./icons";

const icons = { orders: ClipboardList, bill: Receipt, stock: Package, deliveries: Truck, more: Ellipsis };

/**
 * The Shopkeeper tab bar (#550): on the five tab routes of a shop that answers orders, chosen by the saved role and deliver
 * flag. It steps aside while the keyboard is up, so a form keeps its room, and it asks the server again when a tab route is
 * open without it (a shop that has just gone Live), so the saved record catches up.
 */
export function ShopTabs() {
  useSyncExternalStore(access.subscribe, access.get);
  const active = tabAt(usePathname());
  const keys = tabsFor({ answersOrders: access.answersOrders(), role: access.role(), canDeliver: access.canDeliver() });
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setTyping(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setTyping(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  const missing = active !== null && keys === null;
  useEffect(() => {
    const identity = session.get();
    if (missing && "account" in identity) void access.verify(identity.account).catch(() => undefined);
  }, [missing]);
  if (!keys || !active || typing) return null;
  return <TabBar tabs={keys.map((key) => ({ key, label: strings.tabs[key], icon: icons[key] }))} active={active} onSelect={(key) => { if (key !== active) router.replace(tabPaths[key as TabKey]); }} />;
}
