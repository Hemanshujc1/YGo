import { formatNumber, trimDecimal } from "@ygo/format";
import { Button, FieldMessage, PhoneField, SupportEmail, Text } from "@ygo/mobile";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, accountEpoch, session, supportEmail } from "../api";
import { BillCard } from "../components/bill-card";
import { Minus, Plus, Square, SquareCheck } from "../components/icons";
import { SyncStatus } from "../components/sync-status";
import { isCurrentAccount } from "../lib/account";
import { startOfToday } from "../lib/bill-status";
import { type BillCustomer, draftBill, type TypedLine } from "../lib/bill-draft";
import { money } from "../lib/money";
import { openOpeningStock } from "../lib/opening-stock-database";
import { shareBill } from "../lib/share-bill";
import type { BillRow, OpeningStockQueue } from "../lib/opening-stock-queue";
import { stockSync } from "../lib/stock-sync";
import { strings } from "../strings";

const words = strings.bill;
type Item = NonNullable<ReturnType<OpeningStockQueue["cache"]["read"]>>["items"][number];
type Loaded = { kind: "loaded"; accountId: string; epoch: number; shopId: string; queue: OpeningStockQueue };
type Load = { kind: "loading" } | { kind: "failed" } | Loaded;
type Line = { item: Item & { counterPrice: string }; count: string };
/** A price or discount as the shopkeeper leaves its field: no trailing zero, and no dot left after the last digit (#451). */
const leave = (value: string) => trimDecimal(value.trim()).replace(/\.$/, "");

/**
 * S06 Counter bill (#468): whole packs from the Stock saved on this phone, at each pack's counter price, paid
 * by cash or UPI. It works offline: the bill is queued, and Today's bills shows its number once it syncs.
 * Owner's answers on #468 (1–9). #53 adds typed items, a discount, an optional customer with the offers tick,
 * and a search of every bill on this phone by reference or number.
 */
export default function BillScreen() {
  const insets = useSafeAreaInsets();
  const view = useSyncExternalStore(access.subscribe, access.get);
  // A sync pass redraws, so Today's bills shows each new number.
  const status = useSyncExternalStore(stockSync.subscribe, stockSync.get);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [typed, setTyped] = useState<TypedLine[]>([]);
  const [discount, setDiscount] = useState("");
  const [customer, setCustomer] = useState<BillCustomer>({ name: "", phone: "", offers: false });
  const [payment, setPayment] = useState<"cash" | "upi" | null>(null);
  // Field messages show once Save is tapped, not while the shopkeeper is still typing.
  const [tried, setTried] = useState(false);
  const [find, setFind] = useState("");
  const typedKey = useRef(0);
  const [message, setMessage] = useState<{ text: string; saved: boolean } | null>(null);
  const visit = useRef(0);
  // The lines last saved: a second tap before the cleared form redraws must not queue the same bill again.
  // Every save clears the lines to a new array, so it marks a typed-only bill too.
  const savedLines = useRef<Line[] | null>(null);

  async function open(token: number) {
    const identity = session.get();
    if (!("account" in identity)) return;
    const epoch = accountEpoch(), shopId = access.get().shopId;
    try {
      if (!shopId || !access.allowed(identity.account.id, shopId)) return setLoad({ kind: "failed" });
      const queue = await openOpeningStock(identity.account.id);
      if (isCurrentAccount(identity.account.id, epoch) && visit.current === token) setLoad({ kind: "loaded", accountId: identity.account.id, epoch, shopId, queue });
    } catch {
      if (isCurrentAccount(identity.account.id, epoch) && visit.current === token) setLoad({ kind: "failed" });
    }
  }

  useFocusEffect(useCallback(() => {
    const token = ++visit.current;
    void open(token);
    return () => { ++visit.current; };
  }, []));

  const loaded = load.kind === "loaded" && isCurrentAccount(load.accountId, load.epoch) && access.allowed(load.accountId, load.shopId) ? load : null;
  // Stock and Today's bills are read from the phone on opening, after a save and after each sync pass, not on every keystroke.
  const read = useMemo(() => {
    try {
      return loaded ? { items: loaded.queue.cache.read(loaded.shopId)?.items.filter((item) => !item.unavailable) ?? [], bills: loaded.queue.bills(loaded.shopId, startOfToday()) } : null;
    } catch { return null; }
  }, [loaded, status, message]);
  const found = useMemo(() => {
    try { return loaded && find.trim() ? loaded.queue.findBills(loaded.shopId, find) : null; } catch { return null; }
  }, [loaded, status, message, find]);

  const draft = draftBill({ lines: lines.map((line) => ({ packId: line.item.packId, unitPrice: line.item.counterPrice, count: line.count })), typed, discount, customer, payment });
  const wrong = draft.problems.counts || Object.keys(draft.problems.typed).length > 0 || draft.problems.discount !== null || draft.problems.customerName || draft.problems.phone;
  const shown = tried ? draft.problems : null;
  // A discount bigger than the items shows at once; a half-typed one ("10.") waits for Save.
  const discountProblem = tried || draft.problems.discount === "tooBig" ? draft.problems.discount : null;
  const phoneReads = customer.phone.trim() !== "" && !draft.problems.phone;
  const matches = search.trim() ? read?.items.filter((item) => item.name.toLowerCase().includes(search.trim().toLowerCase()) && !lines.some((line) => line.item.packId === item.packId)) ?? [] : [];

  // The bill cards only show while the Stock on the phone is open.
  const share = (bill: BillRow) => loaded ? shareBill({ bill, shopName: access.shopName(), label: (packId) => loaded.queue.label(loaded.shopId, packId) }) : Promise.resolve();

  function add(item: Item) {
    if (!item.counterPrice) return;
    // The contract caps catalog and typed lines at 100 together.
    if (lines.length + typed.length >= 100) return setMessage({ text: words.tooMany, saved: false });
    setLines((current) => [...current, { item: { ...item, counterPrice: item.counterPrice as string }, count: "1" }]);
    setSearch("");
  }
  function setCount(packId: string, count: string) {
    setLines((current) => current.map((line) => line.item.packId === packId ? { ...line, count } : line));
  }
  function step(packId: string, by: number) {
    setLines((current) => current.flatMap((line) => {
      if (line.item.packId !== packId) return [line];
      const next = (Number.parseInt(line.count, 10) || 0) + by;
      return next < 1 ? [] : [{ ...line, count: String(next) }];
    }));
  }

  function addTyped() {
    if (lines.length + typed.length >= 100) return setMessage({ text: words.tooMany, saved: false });
    setTyped((current) => [...current, { key: String(++typedKey.current), name: "", price: "", count: "1" }]);
  }
  function editTyped(key: string, change: Partial<TypedLine>) {
    setTyped((current) => current.map((line) => line.key === key ? { ...line, ...change } : line));
  }
  function stepTyped(key: string, by: number) {
    setTyped((current) => current.flatMap((line) => {
      if (line.key !== key) return [line];
      const next = (Number.parseInt(line.count, 10) || 0) + by;
      return next < 1 ? [] : [{ ...line, count: String(next) }];
    }));
  }

  function save() {
    if (!loaded || !payment || savedLines.current === lines) return;
    if (!isCurrentAccount(loaded.accountId, loaded.epoch) || !access.allowed(loaded.accountId, loaded.shopId)) { access.expire(); return; }
    if (!draft.payload) return setTried(true);
    try {
      const saved = loaded.queue.saveBill(loaded.shopId, draft.payload);
      if (typeof saved === "string") return setMessage({ text: words[saved], saved: false });
      savedLines.current = lines;
      setLines([]); setTyped([]); setDiscount(""); setCustomer({ name: "", phone: "", offers: false }); setPayment(null); setTried(false);
      setMessage({ text: words.saved(saved.reference), saved: true });
      void stockSync.run();
    } catch { setMessage({ text: words.storageFailed, saved: false }); }
  }

  return (
    <ScrollView className="flex-1 bg-bg" keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-4" contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom + 32 }}>
      {/* Offline, only Stock, this screen and S08 open (#394). */}
      <Link href={view.mode === "offline" ? "/stock" : "/"} asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
      <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{words.title}</Text>
      {load.kind === "loading" && <ActivityIndicator className="text-primary" />}
      {(load.kind === "failed" || (load.kind === "loaded" && !read)) && <>
        <Text accessibilityLiveRegion="polite" className="text-body text-danger">{words.loadFailed}</Text>
        <Button label={words.retry} variant="secondary" onPress={() => void open(++visit.current)} />
        <SupportEmail address={supportEmail} className="text-secondary" />
      </>}
      {read && <>
        <SyncStatus />
        {read.items.length === 0 && <Text className="text-body text-muted">{words.empty}</Text>}
        {read.items.length > 0 && <TextInput accessibilityLabel={words.search} placeholder={words.search} value={search} onChangeText={setSearch}
          className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />}
        {search.trim() !== "" && matches.length === 0 && <Text className="text-body text-muted">{words.noMatch}</Text>}
        {matches.map((item) => <Pressable key={item.packId} accessibilityRole="button" accessibilityState={{ disabled: !item.counterPrice }} disabled={!item.counterPrice}
          onPress={() => add(item)} className="gap-1 rounded-card border border-border bg-surface p-4">
          <Text className={item.counterPrice ? "text-headline font-semibold text-text" : "text-headline font-semibold text-muted"}>{item.name} · {trimDecimal(item.packQuantity)} {item.baseUnit}</Text>
          <Text className="text-secondary text-muted">{item.counterPrice ? money(item.counterPrice) : words.noPrice}</Text>
        </Pressable>)}

        <Button label={words.addTyped} variant="secondary" onPress={addTyped} />

        {lines.length + typed.length > 0 && <View className="gap-3">
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.lines}</Text>
          {lines.map((line) => {
            const name = `${line.item.name} · ${trimDecimal(line.item.packQuantity)} ${line.item.baseUnit}`;
            return <View key={line.item.packId} className="gap-2 rounded-card border border-border bg-surface p-4">
              <Text className="text-headline font-semibold text-text">{name}</Text>
              <Text className="text-secondary text-muted">{words.each(money(line.item.counterPrice))}</Text>
              <View className="flex-row items-center gap-3">
                <Pressable accessibilityRole="button" accessibilityLabel={words.less(name)} onPress={() => step(line.item.packId, -1)} className="h-12 w-12 items-center justify-center rounded-button border border-border"><Minus size={20} className="text-text" /></Pressable>
                <TextInput accessibilityLabel={words.count(name)} keyboardType="number-pad" value={line.count} onChangeText={(value) => setCount(line.item.packId, value.replace(/\D/g, ""))}
                  className="h-12 w-20 rounded-input border border-border bg-bg px-3 text-center text-body text-text" />
                <Pressable accessibilityRole="button" accessibilityLabel={words.more(name)} onPress={() => step(line.item.packId, 1)} className="h-12 w-12 items-center justify-center rounded-button border border-border"><Plus size={20} className="text-text" /></Pressable>
              </View>
            </View>;
          })}
          {shown?.counts && <FieldMessage text={words.checkCounts} />}
          {typed.map((line, index) => {
            const label = words.typedLabel(index + 1), problem = shown?.typed[line.key];
            return <View key={line.key} className="gap-2 rounded-card border border-border bg-surface p-4">
              <TextInput accessibilityLabel={`${label}: ${words.typedName}`} placeholder={words.typedName} value={line.name} maxLength={80} onChangeText={(name) => editTyped(line.key, { name })}
                className={`h-[52px] rounded-input border bg-bg px-3 text-body text-text ${problem === "name" ? "border-danger" : "border-border"}`} />
              <TextInput accessibilityLabel={`${label}: ${words.typedPrice}`} placeholder={words.typedPrice} keyboardType="decimal-pad" value={line.price}
                onChangeText={(price) => editTyped(line.key, { price })} onBlur={() => editTyped(line.key, { price: leave(line.price) })}
                className={`h-[52px] rounded-input border bg-bg px-3 text-body text-text ${problem === "price" ? "border-danger" : "border-border"}`} />
              <View className="flex-row items-center gap-3">
                <Pressable accessibilityRole="button" accessibilityLabel={words.less(label)} onPress={() => stepTyped(line.key, -1)} className="h-12 w-12 items-center justify-center rounded-button border border-border"><Minus size={20} className="text-text" /></Pressable>
                <TextInput accessibilityLabel={words.typedCount(label)} keyboardType="number-pad" value={line.count} onChangeText={(value) => editTyped(line.key, { count: value.replace(/\D/g, "") })}
                  className={`h-12 w-20 rounded-input border bg-bg px-3 text-center text-body text-text ${problem === "count" ? "border-danger" : "border-border"}`} />
                <Pressable accessibilityRole="button" accessibilityLabel={words.more(label)} onPress={() => stepTyped(line.key, 1)} className="h-12 w-12 items-center justify-center rounded-button border border-border"><Plus size={20} className="text-text" /></Pressable>
              </View>
              {problem && <FieldMessage text={{ name: words.nameWrong, price: words.priceWrong, count: words.countWrong }[problem]} />}
            </View>;
          })}

          <View>
            <Text className="text-label font-medium text-text">{words.discount}</Text>
            <TextInput accessibilityLabel={words.discount} keyboardType="decimal-pad" value={discount} onChangeText={setDiscount} onBlur={() => setDiscount(leave(discount))}
              className={`mt-2 h-[52px] rounded-input border bg-bg px-3 text-body text-text ${discountProblem ? "border-danger" : "border-border"}`} />
            {discountProblem && <FieldMessage text={discountProblem === "tooBig" ? words.discountTooBig : words.discountWrong} />}
          </View>
          {draft.sum && draft.total && draft.sum !== draft.total && <Text className="text-body text-muted">{words.sum(money(draft.sum), money(draft.discount))}</Text>}
          <Text accessibilityLiveRegion="polite" className="text-title font-semibold text-text">{draft.total ? words.total(money(draft.total)) : words.fillLines}</Text>

          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.customer}</Text>
          <View>
            <Text className="text-label font-medium text-text">{words.customerName}</Text>
            <TextInput accessibilityLabel={words.customerName} value={customer.name} maxLength={80} autoComplete="off" onChangeText={(name) => setCustomer((current) => ({ ...current, name }))}
              className={`mt-2 h-[52px] rounded-input border bg-bg px-3 text-body text-text ${shown?.customerName ? "border-danger" : "border-border"}`} />
            {shown?.customerName && <FieldMessage text={words.nameWrong} />}
          </View>
          <PhoneField label={words.customerPhone} value={customer.phone} editable autofill={false} onSubmitEditing={() => undefined} message={shown?.phone ? words.phoneWrong : null}
            // A new number needs its own consent, so editing the phone clears the tick.
            onChangeText={(phone) => setCustomer((current) => ({ ...current, phone, offers: false }))} />
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: customer.offers && phoneReads, disabled: !phoneReads }} disabled={!phoneReads}
            onPress={() => setCustomer((current) => ({ ...current, offers: !current.offers }))} className="min-h-12 flex-row items-center gap-3">
            {customer.offers && phoneReads ? <SquareCheck size={24} className="text-primary" /> : <Square size={24} className={phoneReads ? "text-text" : "text-muted"} />}
            <Text className={phoneReads ? "flex-1 text-body text-text" : "flex-1 text-body text-muted"}>{words.offers}</Text>
          </Pressable>
          {!phoneReads && <Text className="text-secondary text-muted">{words.offersNeedPhone}</Text>}

          <Text className="text-body text-text">{words.paidBy}</Text>
          <View className="flex-row gap-3">
            {(["cash", "upi"] as const).map((way) => <Pressable key={way} accessibilityRole="radio" accessibilityState={{ checked: payment === way }} onPress={() => setPayment(way)}
              className={payment === way ? "flex-1 items-center rounded-button bg-primary px-4 py-3" : "flex-1 items-center rounded-button border border-primary px-4 py-3"}>
              <Text className={payment === way ? "text-body font-semibold text-on-primary" : "text-body font-semibold text-primary"}>{words.payments[way]}</Text>
            </Pressable>)}
          </View>
          {!payment && <Text className="text-secondary text-muted">{words.choosePayment}</Text>}
          {tried && wrong && <FieldMessage text={words.fixFields} />}
          <Button label={words.save} disabled={!payment} onPress={save} />
        </View>}
        {message && <Text accessibilityLiveRegion="polite" selectable className={message.saved ? "text-body text-success" : "text-body text-danger"}>{message.text}</Text>}

        <TextInput accessibilityLabel={words.find} placeholder={words.find} value={find} onChangeText={setFind} autoCapitalize="characters" autoCorrect={false}
          className="h-[52px] rounded-input border border-border bg-bg px-3 text-body text-text" />
        {found ? <>
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.found(found.length)}</Text>
          {found.length === 0 && <Text className="text-body text-muted">{words.noBill}</Text>}
          {found.map((bill) => <BillCard key={bill.id} bill={bill} onShare={() => share(bill)} />)}
        </> : <>
          <Text accessibilityRole="header" className="text-title font-semibold text-text">{words.today} · {formatNumber(read.bills.length)}</Text>
          {read.bills.length === 0 && <Text className="text-body text-muted">{words.none}</Text>}
          {read.bills.map((bill) => <BillCard key={bill.id} bill={bill} onShare={() => share(bill)} />)}
        </>}
      </>}
    </ScrollView>
  );
}
