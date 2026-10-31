import { Text } from "@ygo/mobile";
import { Link } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable } from "react-native";
import { accountEpoch, session } from "../api";
import { isCurrentAccount } from "../lib/account";
import { openOpeningStock } from "../lib/opening-stock-database";
import { stockSync } from "../lib/stock-sync";
import { strings } from "../strings";
import { CircleCheck, Cloud } from "./icons";

const words = strings.sync;

/** The app's sync state in one line; opens S08 (#395). */
export function SyncStatus() {
  const status = useSyncExternalStore(stockSync.subscribe, stockSync.get);
  const [counts, setCounts] = useState<{ attention: number; waiting: number } | null>(null);
  useEffect(() => {
    if (status.running) return;
    const identity = session.get();
    if (!("account" in identity)) return;
    const id = identity.account.id, epoch = accountEpoch();
    let gone = false;
    openOpeningStock(id).then((queue) => {
      if (gone || !isCurrentAccount(id, epoch)) return;
      const held = queue.attentionCount();
      setCounts({ attention: queue.failureCount() + held, waiting: queue.count() - held });
    }).catch(() => undefined);
    return () => { gone = true; };
  }, [status]);

  const tone = counts?.attention ? "text-danger" : counts?.waiting ? "text-pending" : "text-success";
  const line = !counts ? words.checking : counts.attention ? words.attention(counts.attention) : counts.waiting ? words.waiting(counts.waiting) : words.allSynced;
  return (
    <Link href="/sync" asChild>
      <Pressable accessibilityRole="button" className="min-h-12 flex-row items-center gap-2 py-2">
        {counts && !counts.attention && !counts.waiting ? <CircleCheck size={20} className={tone} /> : <Cloud size={20} className={tone} />}
        <Text className={`flex-1 text-body font-semibold ${tone}`}>{status.running ? `${line} · ${words.syncing}` : line}</Text>
      </Pressable>
    </Link>
  );
}
