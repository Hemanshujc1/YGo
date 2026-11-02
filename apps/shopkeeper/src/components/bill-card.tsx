import { formatPhone, formatTime } from "@ygo/format";
import { Button, SupportEmail, Text } from "@ygo/mobile";
import { useState } from "react";
import { View } from "react-native";
import { supportEmail } from "../api";
import { Share2 } from "./icons";
import { billStatus } from "../lib/bill-status";
import { money } from "../lib/money";
import type { BillRow } from "../lib/opening-stock-queue";
import { strings } from "../strings";

const tones = { muted: "text-secondary text-muted", warning: "text-secondary text-warning", danger: "text-secondary text-danger" } as const;

/**
 * One counter bill on the Bill screen and S08 (#468): its reference, total, payment, customer (#53) and status line.
 * Share bill makes its PDF, before or after sync; a refused bill has none (#53).
 */
export function BillCard({ bill, syncedAt, onShare }: { bill: BillRow; syncedAt?: string | null; onShare: () => Promise<void> }) {
  const words = strings.bill, line = billStatus(bill);
  const [sharing, setSharing] = useState(false), [failed, setFailed] = useState(false);
  function share() {
    setSharing(true); setFailed(false);
    onShare().catch(() => setFailed(true)).finally(() => setSharing(false));
  }
  return <View className="gap-1 rounded-card border border-border bg-surface p-4">
    <Text selectable className="text-headline font-semibold text-text">{words.reference(bill.reference)}</Text>
    <Text className="text-body text-text">{words.summary(money(bill.total), words.payments[bill.payment], bill.lines.length + (bill.manualLines?.length ?? 0))}</Text>
    {bill.customer && <Text selectable className="text-secondary text-muted">{words.customerLine([bill.customer.name, bill.customer.phone && formatPhone(bill.customer.phone)].filter((part) => part !== undefined))}</Text>}
    <Text className={tones[line.tone]}>{line.text}</Text>
    {syncedAt && <Text className="text-secondary text-muted">{strings.sync.syncedAt(formatTime(syncedAt))}</Text>}
    {bill.status === "refused" ? <SupportEmail address={supportEmail} className="text-secondary" />
      : <View className="mt-2"><Button label={words.share} icon={Share2} variant="secondary" busy={sharing} onPress={share} /></View>}
    {failed && <Text accessibilityRole="alert" className="text-secondary text-danger">{words.shareFailed}</Text>}
  </View>;
}
