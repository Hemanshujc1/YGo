import { CounterBillVoidReason, type ShopCounterBill, VoidCounterBillBody } from "@ygo/contracts";
import { formatDateTime } from "@ygo/format";
import { Button, FieldMessage, Text, useInFront } from "@ygo/mobile";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, accountEpoch, api, session } from "../api";
import { ReasonPicker } from "../components/reason-picker";
import { isCurrentAccount } from "../lib/account";
import { useAccountRole } from "../lib/account-role";
import { canVoid, createCounterBillVoids, voidedLine } from "../lib/counter-bill-voids";
import { money } from "../lib/money";
import { openOpeningStock } from "../lib/opening-stock-database";
import type { OpeningStockQueue } from "../lib/opening-stock-queue";
import { stockSync } from "../lib/stock-sync";
import { strings } from "../strings";
import { backPath } from "../lib/back-path";

// S37 Void a bill (#492): the shop's bills of the last 2 days from the server; the Owner voids one while the
// server says it may. Owner's answers on #54 (2–5, 9–12) and on #492 (1–10).

const words = strings.voids;
type Sheet = { bill: ShopCounterBill; reason: CounterBillVoidReason | null; note: string; message: string | null };

const billName = (bill: ShopCounterBill) => (bill.number === null ? words.numberPending : words.number(bill.number));

function BillRow({ bill, onVoid, busy, mayVoid }: { bill: ShopCounterBill; onVoid: () => void; busy: boolean; mayVoid: boolean }) {
  return (
    <View className="gap-1 rounded-card border border-border bg-surface p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-headline font-semibold text-text">{billName(bill)}</Text>
        <Text className="text-secondary tabular-nums text-muted">{formatDateTime(bill.madeAt)}</Text>
      </View>
      <Text selectable className="text-secondary text-muted">{words.reference(bill.reference)}</Text>
      {/* A bill the server couldn't read has no amount (owner's note on #492). */}
      {bill.total !== null && bill.payment !== null && <Text className="text-body tabular-nums text-text">{words.summary(money(bill.total), strings.bill.payments[bill.payment])}</Text>}
      {bill.voided ? <Text className="text-secondary font-medium text-text">{voidedLine(bill.voided)}</Text>
        // A bill the server couldn't read can't be numbered (#470), so it promises nothing.
        : bill.number === null ? bill.total !== null && <Text className="text-secondary text-muted">{words.pending}</Text>
        // Staff see the bill with no void action (#494).
        : canVoid(bill) ? mayVoid && <View className="mt-2"><Button label={words.action} variant="secondary" busy={busy} onPress={onVoid} /></View>
        : <Text className="text-secondary text-muted">{words.tooOld}</Text>}
    </View>
  );
}

function VoidSheet({ sheet, busy, onChange, onConfirm, onCancel }: {
  sheet: Sheet; busy: boolean; onChange: (next: Partial<Sheet>) => void; onConfirm: (body: VoidCounterBillBody) => void; onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  // The server's own rule: a reason, and for Other a note of 1 to 500 characters.
  const body = sheet.reason ? VoidCounterBillBody.safeParse(sheet.reason === "other" ? { reason: "other", note: sheet.note } : { reason: sheet.reason }) : null;
  const noteWrong = sheet.reason === "other" && sheet.note !== "" && !body?.success;
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={busy ? () => undefined : onCancel}>
      {/* Padding on Android too: edge to edge, the window no longer shrinks for the keyboard. */}
      <KeyboardAvoidingView behavior="padding" className="flex-1 justify-end bg-scrim">
        <View accessibilityViewIsModal className="gap-2 rounded-t-sheet bg-raised px-4 pt-4" style={{ paddingBottom: insets.bottom + 12 }}>
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.sheet.title}</Text>
          <Text className="text-body text-text">{billName(sheet.bill)} · {words.reference(sheet.bill.reference)}</Text>
          <ReasonPicker reasons={CounterBillVoidReason.options} chosen={sheet.reason} words={words.reasons} label={words.sheet.reasons} disabled={busy}
            onChoose={(reason) => onChange({ reason, message: null })} />
          {sheet.reason === "other" && (
            <View>
              <TextInput
                accessibilityLabel={words.sheet.note}
                placeholder={words.sheet.note}
                value={sheet.note}
                onChangeText={(note) => onChange({ note, message: null })}
                editable={!busy}
                multiline
                maxLength={500}
                className={`min-h-[52px] rounded-input border bg-surface px-3 py-3 text-body text-text ${noteWrong ? "border-danger" : "border-border-strong"}`}
              />
              {noteWrong && <FieldMessage text={words.sheet.noteWrong} />}
            </View>
          )}
          <Text className="text-secondary text-muted">{words.sheet.warning}</Text>
          {sheet.message && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{sheet.message}</Text>}
          <Button label={words.sheet.confirm} variant="destructive" busy={busy} disabled={!body?.success} onPress={() => body?.success && onConfirm(body.data)} />
          <Button label={words.sheet.cancel} variant="text" disabled={busy} onPress={onCancel} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Bills on this phone that haven't reached the server, so can't be listed or voided yet (owner's answer 7 on #492). */
function useWaitingBills() {
  const status = useSyncExternalStore(stockSync.subscribe, stockSync.get);
  const [opened, setOpened] = useState<{ accountId: string; epoch: number; shopId: string; queue: OpeningStockQueue } | null>(null);
  useFocusEffect(useCallback(() => {
    let live = true;
    const identity = session.get(), shopId = access.get().shopId, epoch = accountEpoch();
    if ("account" in identity && shopId && access.allowed(identity.account.id, shopId)) {
      const accountId = identity.account.id;
      // Only a hint: a phone database that won't open just shows no line.
      openOpeningStock(accountId).then((queue) => live && setOpened({ accountId, epoch, shopId, queue }), () => undefined);
    }
    return () => { live = false; };
  }, []));
  return useMemo(() => {
    try {
      return opened && isCurrentAccount(opened.accountId, opened.epoch) && access.allowed(opened.accountId, opened.shopId) ? opened.queue.billCount() : 0;
    } catch { return 0; }
  }, [opened, status]);
}

/** Whatever the list shows as voided is kept on the phone, so the bill cards show it too (#493). A phone database that won't open just keeps nothing. */
function rememberVoids(accountId: string, epoch: number) {
  return (bills: ShopCounterBill[]) => {
    // Only the account that opened this screen: a late answer after a switch is not saved into another account's database.
    if (!isCurrentAccount(accountId, epoch) || !bills.some((bill) => bill.voided)) return;
    openOpeningStock(accountId).then((queue) => queue.saveVoids(bills), () => undefined).catch(() => undefined);
  };
}

export default function VoidBillScreen() {
  const insets = useSafeAreaInsets();
  const [voids] = useState(() => {
    const identity = session.get();
    return createCounterBillVoids(api, "account" in identity ? rememberVoids(identity.account.id, accountEpoch()) : undefined);
  });
  const view = useSyncExternalStore(voids.subscribe, voids.get);
  const role = useAccountRole();
  const owner = role === "owner";
  useInFront(voids);
  const waiting = useWaitingBills();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // Bills that just synced now have numbers on the server, so the list is read again to show them.
  const waited = useRef(waiting);
  useEffect(() => {
    if (waiting < waited.current) void voids.retry();
    waited.current = waiting;
  }, [waiting, voids]);

  // A sheet open when the role turns out to be Staff closes for good, so it can't come back if the role flips again (#494).
  useEffect(() => { if (!owner) setSheet(null); }, [owner]);

  async function confirm(body: VoidCounterBillBody) {
    if (!sheet || !owner) return;
    const id = sheet.bill.id;
    const { close, message } = await voids.voidBill(id, body);
    // Kept open with the reason and note when the void can be tried again; otherwise the list shows why.
    // Only the sheet of the bill this void was for changes.
    setSheet((current) => (current?.bill.id !== id ? current : close ? null : message ? { ...current, message } : current));
  }

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}
        refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void voids.refresh()} progressViewOffset={insets.top} />}
      >
        <Link href={backPath()} asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
        {role === "staff" && <Text className="text-body text-muted">{words.staffView}</Text>}
        {waiting > 0 && <Text className="text-body text-muted">{words.waiting(waiting)}</Text>}
        {view.notice && <Text accessibilityLiveRegion="polite" className={`text-body ${view.notice.tone === "success" ? "text-success" : "text-danger"}`}>{view.notice.text}</Text>}
        {view.status === "loading" && (
          <View className="min-h-12 flex-row items-center gap-2">
            <ActivityIndicator className="text-primary" />
            <Text className="text-body text-muted">{words.loading}</Text>
          </View>
        )}
        {view.message && <Text accessibilityLiveRegion="polite" className="text-body text-danger">{view.message}</Text>}
        {view.status === "failed" && <Button label={words.retry} variant="secondary" onPress={() => void voids.retry()} />}
        {view.bills?.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {view.bills?.map((bill) => (
          <BillRow key={bill.id} bill={bill} busy={view.voiding === bill.id} mayVoid={owner}
            onVoid={() => !view.voiding && setSheet({ bill, reason: null, note: "", message: null })} />
        ))}
      </ScrollView>
      {/* Never for Staff or an unknown role, not even in the render before the effect above clears it (#494). */}
      {sheet && owner && (
        <VoidSheet
          sheet={sheet}
          busy={view.voiding === sheet.bill.id}
          onChange={(next) => setSheet((current) => (current ? { ...current, ...next } : null))}
          onConfirm={(body) => void confirm(body)}
          onCancel={() => setSheet(null)}
        />
      )}
    </View>
  );
}
