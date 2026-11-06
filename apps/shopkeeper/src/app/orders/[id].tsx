import { RejectReason, type ShopOrderResponse } from "@ygo/contracts";
import { formatTime } from "@ygo/format";
import { Button, StatusChip, Text, useInFront } from "@ygo/mobile";
import { Link, router, useLocalSearchParams } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import QRCode from "react-native-qrcode-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, session } from "../../api";
import { Countdown, useSecondsLeft } from "../../components/countdown";
import { ReasonPicker } from "../../components/reason-picker";
import { useAccountRole } from "../../lib/account-role";
import { money } from "../../lib/money";
import { createShopOrder, lineLabel, shortLabel, treatments } from "../../lib/shop-orders";
import { strings } from "../../strings";

// S05 New order detail (#431): Accept is the biggest and lowest button; Reject asks for a reason first.

const words = strings.orders;

function Detail({ order }: { order: ShopOrderResponse }) {
  const { address } = order;
  return (
    <View className="gap-4">
      <View className="gap-2">
        <StatusChip word={words.statuses[order.status]} treatment={treatments[order.status]} />
        <Text className="text-secondary tabular-nums text-muted">{formatTime(order.placedAt)}</Text>
        {order.rejectReason && <Text className="text-body text-text">{words.rejectedBecause(words.reasons[order.rejectReason])}</Text>}
      </View>
      <View className="rounded-card border border-border bg-surface px-4">
        {order.lines.map((line, index) => (
          <View key={index} className={`flex-row gap-3 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
            <View className="flex-1">
              <Text className="text-body font-semibold text-text">{line.name}</Text>
              <Text className="text-secondary tabular-nums text-muted">{lineLabel(line)}</Text>
            </View>
            <Text className="text-label font-semibold tabular-nums text-text">{money(line.lineTotal)}</Text>
          </View>
        ))}
      </View>
      <View className="rounded-card border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-body font-semibold text-text">{words.collect}</Text>
          <Text className="text-title font-semibold tabular-nums text-text">{money(order.total)}</Text>
        </View>
        <Text className="mt-2 text-secondary text-muted">{words.collectNote}</Text>
      </View>
      <View>
        <Text className="text-secondary text-muted">{words.deliverTo}</Text>
        <Text selectable className="text-body text-text">
          {`${words.labels[address.label]} · ${[address.flat, address.areaLine, address.pincode].filter(Boolean).join(", ")}`}
        </Text>
      </View>
    </View>
  );
}

/** "Reject this order?": a fixed list of reasons; Reject stays off until one is chosen (design system, Reason picker). */
function RejectSheet({ chosen, onChoose, onConfirm, onCancel }: {
  chosen: RejectReason | null;
  onChoose: (reason: RejectReason) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-scrim">
        <View accessibilityViewIsModal className="gap-2 rounded-t-sheet bg-raised px-4 pt-4" style={{ paddingBottom: insets.bottom + 12 }}>
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.sheet.title}</Text>
          <ReasonPicker reasons={RejectReason.options} chosen={chosen} words={words.reasons} onChoose={onChoose} />
          <Button label={words.sheet.confirm} disabled={!chosen} onPress={onConfirm} />
          <Button label={words.sheet.cancel} variant="text" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

export default function OrderScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [order] = useState(() => createShopOrder(api, id ?? ""));
  const view = useSyncExternalStore(order.subscribe, order.get);
  useInFront(order);
  const [rejecting, setRejecting] = useState<{ chosen: RejectReason | null } | null>(null);
  const owner = useAccountRole() === "owner";
  const [deliverers, setDeliverers] = useState<Awaited<ReturnType<typeof api.shopDeliverers>> | null>(null);
  const [delivererId, setDelivererId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [handoverCode, setHandoverCode] = useState("");
  const [payment, setPayment] = useState<"cash" | "upi">("cash");
  const [deliveryMessage, setDeliveryMessage] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [camera, setCamera] = useState<CameraView | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoUploadId, setPhotoUploadId] = useState<string | null>(null);
  const [proofReason, setProofReason] = useState<"customer_phone_unavailable" | "customer_phone_not_present" | "someone_else_receiving" | "other" | null>(null);
  const [failureReason, setFailureReason] = useState<"no_one_at_address" | "customer_refused" | "address_not_found" | "other" | null>(null);
  const [showQr, setShowQr] = useState(false);
  const identity = session.get();
  const accountId = "account" in identity ? identity.account.id : null;
  const shown = view.order;
  const isNew = shown?.status === "placed";
  const seconds = useSecondsLeft(isNew ? shown.expiresAt : null, view.offset);
  const failureSeconds = useSecondsLeft(shown?.deliveryFailureReadyAt ?? null, view.offset);
  const timeUp = view.expired || seconds === 0;
  const done = (answered: boolean) => answered && router.replace("/orders");

  async function saveProofPhoto(orderId: string, uri: string) {
    const blob = await (await fetch(uri)).blob();
    const upload = await api.deliveryPhotoUpload(orderId, { contentType: "image/jpeg", byteLength: blob.size });
    if (!upload.ok) throw new Error(strings.errors[upload.code]);
    const sent = await fetch(upload.data.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (!sent.ok) throw new Error(strings.errors.DELIVERY_PHOTO_INVALID);
    setPhotoUploadId(upload.data.id);
  }

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        contentContainerClassName="gap-4 px-4"
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={view.refreshing} onRefresh={() => void order.refresh()} progressViewOffset={insets.top} />}
      >
        <Link href="/orders" asChild><Pressable accessibilityRole="button" className="py-3"><Text className="text-body text-primary">{words.back}</Text></Pressable></Link>
        <Text accessibilityRole="header" className="text-title-large font-semibold text-text">{shown ? words.detailTitle(shown.number) : words.titleLoading}</Text>
        {shown?.customer?.name && <Text className="text-body text-text">{words.customer}: {shown.customer.name}{shown.customer.phone ? ` · ${shown.customer.phone}` : ""}</Text>}
        {isNew && seconds !== null && <Countdown seconds={timeUp ? 0 : seconds} />}
        {view.status === "loading" && (
          <View className="min-h-12 flex-row items-center gap-2">
            <ActivityIndicator className="text-primary" />
            <Text className="text-body text-muted">{words.loadingOne}</Text>
          </View>
        )}
        {view.status === "failed" && (
          <View className="items-start">
            <Text className="text-body font-semibold text-text">{words.failed}</Text>
            <Text className="text-secondary text-muted">{view.message}</Text>
            <Button label={words.retry} onPress={() => void order.retry()} variant="text" />
          </View>
        )}
        {view.notice && (
          <View accessibilityLiveRegion="polite" className="gap-1">
            <Text className="text-body font-semibold text-danger">{view.notice}</Text>
            {view.shortLines.length > 0 && <Text className="text-secondary text-text">{words.shortTitle}</Text>}
            {view.shortLines.map((line, index) => <Text key={index} className="text-secondary tabular-nums text-text">{`• ${shortLabel(line)}`}</Text>)}
          </View>
        )}
        {shown && <Detail order={shown} />}
        {shown && (["accepted", "preparing"].includes(shown.status) || (shown.status === "ready" && owner)) && <View className="gap-2">
          {shown.status === "accepted" && <Button label={words.preparing} busy={working} onPress={() => {
            setWorking(true); void api.advanceShopOrder(shown.id, "preparing").then((result) => { setWorking(false); if (result.ok) void order.refresh(); else setDeliveryMessage(strings.errors[result.code]); });
          }} />}
          {(shown.status === "preparing" || shown.status === "ready") && <View className="gap-2 rounded-card border border-border bg-surface p-4">
            <Text className="text-body font-semibold text-text">{words.assign}</Text>
            {deliverers?.ok && deliverers.data.deliverers.map((person) => <Pressable key={person.accountId} accessibilityRole="radio" accessibilityState={{ checked: delivererId === person.accountId }} onPress={() => setDelivererId(person.accountId)} className={`rounded-button border px-3 py-3 ${delivererId === person.accountId ? "border-primary" : "border-border"}`}>
              <Text className="text-body text-text">{person.name ?? words.assignOwner}{person.role === "owner" ? ` · ${words.assignOwner}` : ""}</Text>
            </Pressable>)}
            {!deliverers && <Button label={words.chooseDeliverer} variant="secondary" onPress={() => void api.shopDeliverers().then(setDeliverers)} />}
            <Button label={words.ready} busy={working} disabled={!delivererId} onPress={() => {
              if (!delivererId) return;
              setWorking(true); void api.readyShopOrder(shown.id, { accountId: delivererId }).then((result) => { setWorking(false); if (result.ok) void order.refresh(); else setDeliveryMessage(strings.errors[result.code]); });
            }} />
          </View>}
        </View>}
        {shown && shown.delivererId === accountId && shown.status === "ready" && <Button label={words.outForDelivery} busy={working} onPress={() => {
          setWorking(true); void api.advanceShopOrder(shown.id, "out-for-delivery").then((result) => { setWorking(false); if (result.ok) void order.refresh(); else setDeliveryMessage(strings.errors[result.code]); });
        }} />}
        {shown && shown.delivererId === accountId && shown.status === "out_for_delivery" && <Button label={words.arrived} busy={working} onPress={() => {
          setWorking(true); void api.advanceShopOrder(shown.id, "arrived").then((result) => { setWorking(false); if (result.ok) void order.refresh(); else setDeliveryMessage(strings.errors[result.code]); });
        }} />}
        {shown && shown.delivererId === accountId && shown.status === "arrived" && <View className="gap-2 rounded-card border border-border bg-surface p-4">
          <Text className="text-body font-semibold text-text">{words.code}</Text>
          <TextInput accessibilityLabel={words.code} keyboardType="number-pad" maxLength={4} value={handoverCode} onChangeText={setHandoverCode} editable={photoUploadId !== null} className="rounded-input border border-border-strong bg-bg px-3 py-3 text-title text-text" />
          <Text className="text-body font-semibold text-text">{words.payment}</Text>
          <View className="flex-row gap-2"><Button label={words.cash} variant={payment === "cash" ? "primary" : "secondary"} onPress={() => setPayment("cash")} /><Button label={words.upi} variant={payment === "upi" ? "primary" : "secondary"} onPress={() => setPayment("upi")} /></View>
          {payment === "upi" && shown.shopUpiId && <Button label={words.showQr} variant="secondary" onPress={() => setShowQr(true)} />}
          <Text className="text-secondary text-muted">{words.photoRequired}</Text>
          {photoUri && <View className="gap-2"><Text className="text-body font-semibold text-text">{words.reviewPhoto}</Text><Image source={{ uri: photoUri }} resizeMode="contain" className="h-64 w-full rounded-card bg-black" /></View>}
          {photoUri && !photoUploadId
            ? <View className="gap-2"><Button label={words.savePhoto} busy={working} onPress={() => {
                setWorking(true); void saveProofPhoto(shown.id, photoUri).then(() => setDeliveryMessage(null)).catch((error: unknown) => setDeliveryMessage(error instanceof Error ? error.message : strings.errors.DELIVERY_PHOTO_INVALID)).finally(() => setWorking(false));
              }} /><Button label={words.retakePhoto} variant="secondary" disabled={working} onPress={() => setPhotoUri(null)} /></View>
            : <Button label={photoUploadId ? words.retakePhoto : words.takePhoto} busy={working} onPress={() => {
                if (photoUploadId) { setPhotoUploadId(null); setPhotoUri(null); return; }
                if (cameraPermission?.granted) setCameraOpen(true);
                else void requestCameraPermission().then((permission) => { if (permission.granted) setCameraOpen(true); });
              }} />}
          <Button label={words.completeDelivery} disabled={!photoUploadId || handoverCode.length !== 4} busy={working} onPress={() => {
            if (!photoUploadId) return;
            setWorking(true); void api.completeDelivery(shown.id, { handoverCode, payment, photoUploadId }).then((result) => { setWorking(false); if (result.ok) router.replace("/orders"); else setDeliveryMessage(strings.errors[result.code]); });
          }} />
          <Text className="text-secondary font-semibold text-text">{words.proofExceptionReason}</Text>
          {([
            ["customer_phone_unavailable", words.proofPhoneUnavailable],
            ["customer_phone_not_present", words.proofNoPhone],
            ["someone_else_receiving", words.proofSomeoneElse],
            ["other", words.proofOther],
          ] as const).map(([reason, label]) => <Pressable key={reason} accessibilityRole="radio" accessibilityState={{ checked: proofReason === reason }} onPress={() => setProofReason(reason)} className={`rounded-button border px-3 py-2 ${proofReason === reason ? "border-primary" : "border-border"}`}><Text className="text-body text-text">{label}</Text></Pressable>)}
          <Button label={words.proofException} variant="secondary" disabled={!proofReason || !photoUploadId} busy={working} onPress={() => {
            if (!proofReason || !photoUploadId) return;
            setWorking(true); void api.completeDeliveryProofException(shown.id, { reason: proofReason, photoUploadId, payment }).then((result) => { setWorking(false); if (result.ok) { setDeliveryMessage(words.proofExceptionRecorded); void order.refresh(); } else setDeliveryMessage(strings.errors[result.code]); });
          }} />
          {shown.customer?.phone
            ? <Button label={words.callCustomer} variant="secondary" busy={working} onPress={() => {
              setWorking(true); void api.markDeliveryCallAttempt(shown.id).then(async (result) => {
                setWorking(false);
                if (!result.ok) return setDeliveryMessage(strings.errors[result.code]);
                void order.refresh();
                try { await Linking.openURL(`tel:${shown.customer?.phone}`); } catch { setDeliveryMessage(words.customer); }
              });
            }} />
            // No number to dial (#523): record the attempt on its own so the wait can still start.
            : <Button label={words.markCallAttempt} variant="secondary" busy={working} onPress={() => {
              setWorking(true); void api.markDeliveryCallAttempt(shown.id).then((result) => {
                setWorking(false);
                if (result.ok) void order.refresh(); else setDeliveryMessage(strings.errors[result.code]);
              });
            }} />}
          {failureSeconds !== null && failureSeconds > 0 && <Countdown seconds={failureSeconds} />}
          {([ ["no_one_at_address", words.failureNoOne], ["customer_refused", words.failureRefused], ["address_not_found", words.failureAddress], ["other", words.failureOther] ] as const).map(([reason, label]) => <Pressable key={reason} accessibilityRole="radio" accessibilityState={{ checked: failureReason === reason }} onPress={() => setFailureReason(reason)} className={`rounded-button border px-3 py-2 ${failureReason === reason ? "border-primary" : "border-border"}`}><Text className="text-body text-text">{label}</Text></Pressable>)}
          <Button label={words.sendFailure} variant="destructive" disabled={failureSeconds !== 0 || !failureReason || !photoUploadId} busy={working} onPress={() => {
            if (!failureReason || !photoUploadId) return;
            setWorking(true); void api.failDelivery(shown.id, { reason: failureReason, photoUploadId }).then((result) => { setWorking(false); if (result.ok) router.replace("/orders"); else setDeliveryMessage(strings.errors[result.code]); });
          }} />
        </View>}
        {shown && deliveryMessage && <Text accessibilityLiveRegion="polite" className="text-secondary text-danger">{deliveryMessage}</Text>}
      </ScrollView>

      {isNew && (
        <View className="gap-2.5 border-t border-border bg-surface px-4 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
          <Button
            label={view.answering === "reject" ? words.rejecting : words.reject}
            variant="secondary"
            busy={view.answering === "reject"}
            disabled={timeUp || view.answering !== null}
            // After NOT_ENOUGH_STOCK, "Items out of stock" is the likely reason (owner's answer 8 on #431).
            onPress={() => setRejecting({ chosen: view.shortLines.length > 0 ? "out_of_stock" : null })}
          />
          <Button
            label={view.answering === "accept" ? words.accepting : words.accept}
            busy={view.answering === "accept"}
            disabled={timeUp || view.answering !== null}
            onPress={() => void order.accept().then(done)}
          />
        </View>
      )}
      {rejecting && (
        <RejectSheet
          chosen={rejecting.chosen}
          onChoose={(chosen) => setRejecting({ chosen })}
          onCancel={() => setRejecting(null)}
          onConfirm={() => {
            if (!rejecting.chosen) return;
            const reason = rejecting.chosen;
            setRejecting(null);
            void order.reject(reason).then(done);
          }}
        />
      )}
      <Modal visible={cameraOpen} animationType="slide" onRequestClose={() => setCameraOpen(false)}>
        {/* CameraView is not a NativeWind component, so className would be ignored and it would collapse to nothing. */}
        <CameraView ref={setCamera} style={{ flex: 1 }} facing="back">
          <View className="flex-1 justify-end gap-3 bg-transparent p-5" style={{ paddingBottom: insets.bottom + 20 }}>
            <Button label={words.takePhoto} busy={working} onPress={() => {
              const orderId = shown?.id;
              if (!camera || !orderId) return;
              setWorking(true);
              void camera.takePictureAsync({ quality: 0.7 }).then(async (picture) => {
                if (!picture) throw new Error("No photo captured");
                const compressed = await ImageManipulator.manipulateAsync(picture.uri, [{ resize: { width: 1280 } }], { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG });
                setPhotoUri(compressed.uri);
                setCameraOpen(false);
                setDeliveryMessage(null);
              }).catch((error: unknown) => setDeliveryMessage(error instanceof Error ? error.message : words.staffDeliveryFailed)).finally(() => setWorking(false));
            }} />
            <Button label={words.back} variant="secondary" disabled={working} onPress={() => setCameraOpen(false)} />
          </View>
        </CameraView>
      </Modal>
      <Modal transparent visible={showQr} animationType="fade" onRequestClose={() => setShowQr(false)}>
        <View className="flex-1 items-center justify-center gap-4 bg-scrim p-6">
          <View className="items-center gap-4 rounded-card bg-white p-6">
            <Text className="text-headline font-semibold text-text">{words.showQr}</Text>
            {shown?.shopUpiId && <QRCode value={`upi://pay?pa=${encodeURIComponent(shown.shopUpiId)}&pn=YGo%20Shop&am=${encodeURIComponent(shown.total)}&cu=INR&tn=Order%20${shown.number}`} size={220} />}
            <Button label={words.back} onPress={() => setShowQr(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}
