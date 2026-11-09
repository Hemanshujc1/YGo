import {
  OrderLineChangeReason,
  type PartialAcceptLine,
  type PartialAcceptPreviewResponse,
  RejectReason,
  type ShopDeliverersResponse,
  type ShopOrderLine,
  type ShopOrderResponse,
} from "@ygo/contracts";
import type { ApiResult } from "@ygo/api-client";
import { formatTime } from "@ygo/format";
import { Button, Confirm, StatusChip, Text, useInFront } from "@ygo/mobile";
import { Link, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import QRCode from "react-native-qrcode-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { access, api, session } from "../../api";
import { Countdown, useSecondsLeft } from "../../components/countdown";
import { Minus, Plus } from "../../components/icons";
import { ReasonPicker } from "../../components/reason-picker";
import { money } from "../../lib/money";
import { createShopOrder, lineLabel, pack, shortLabel, treatments } from "../../lib/shop-orders";
import { strings } from "../../strings";

// S05 New order detail (#431): Accept is the biggest and lowest button; Reject asks for a reason first.

const words = strings.orders;

function proposalKey(
  lines: ShopOrderLine[],
  lineEdits: Map<string, { count: number; reason: OrderLineChangeReason | null }>
): string | null {
  let hasChanges = false;
  let remainingCount = 0;
  const parts: string[] = [];
  for (const l of lines) {
    const edit = lineEdits.get(l.listingId);
    const count = edit !== undefined ? edit.count : l.count;
    if (count < l.count) {
      hasChanges = true;
      parts.push(`${l.listingId}:${count}:${edit?.reason ?? ""}`);
    }
    if (count > 0) remainingCount++;
  }
  if (!hasChanges || remainingCount === 0) return null;
  return parts.sort().join("|");
}

function Detail({
  order,
  editing = false,
  lineEdits,
  disabled = false,
  onStepDown,
  onStepUp,
  onRemoveLine,
  onUndoLine,
  onOpenReason,
  previewTotal,
  previewFailed = false,
}: {
  order: ShopOrderResponse;
  editing?: boolean;
  lineEdits?: Map<string, { count: number; reason: OrderLineChangeReason | null }>;
  disabled?: boolean;
  onStepDown?: (listingId: string) => void;
  onStepUp?: (listingId: string) => void;
  onRemoveLine?: (listingId: string) => void;
  onUndoLine?: (listingId: string) => void;
  onOpenReason?: (listingId: string) => void;
  previewTotal?: PartialAcceptPreviewResponse | null;
  previewFailed?: boolean;
}) {
  const { address } = order;
  const proposal = order.proposal;
  const isAwaiting = order.status === "awaiting_customer_confirm";

  return (
    <View className="gap-4">
      <View className="gap-2">
        <StatusChip word={words.statuses[order.status]} treatment={treatments[order.status]} />
        <Text className="text-secondary tabular-nums text-muted">{formatTime(order.placedAt)}</Text>
        {order.rejectReason && <Text className="text-body text-text">{words.rejectedBecause(words.reasons[order.rejectReason])}</Text>}
      </View>
      <View className="rounded-card border border-border bg-surface px-4">
        {editing ? (
          order.lines.map((line, index) => {
            const edit = lineEdits?.get(line.listingId);
            const count = edit !== undefined ? edit.count : line.count;
            const reason = edit?.reason ?? null;
            const isReduced = count < line.count;
            const isPart = line.part !== null;
            const originalLabel = lineLabel(line);
            const proposedLabel = line.part !== null
              ? [line.brand, count === 0 ? `0 × ${pack(line.quantity, line.baseUnit)}` : words.part(pack(line.part, line.baseUnit), pack(line.quantity, line.baseUnit))].filter(Boolean).join(" · ")
              : lineLabel({ ...line, count });

            return (
              <View key={line.listingId} className={`gap-2 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-body font-semibold text-text">{line.name}</Text>
                    {isReduced ? (
                      <View className="flex-row items-center gap-1.5 flex-wrap">
                        <Text className="text-secondary line-through text-muted tabular-nums">
                          {originalLabel}
                        </Text>
                        <Text className="text-secondary font-medium tabular-nums text-text">
                          {proposedLabel}
                        </Text>
                      </View>
                    ) : (
                      <Text className="text-secondary tabular-nums text-muted">{originalLabel}</Text>
                    )}
                  </View>
                  <View className="items-end">
                    {isReduced ? (
                      <Text className="text-secondary line-through text-muted tabular-nums">
                        {money(line.lineTotal)}
                      </Text>
                    ) : (
                      <Text className="text-label font-semibold tabular-nums text-text">
                        {money(line.lineTotal)}
                      </Text>
                    )}
                  </View>
                </View>

                <View className="flex-row items-center justify-between gap-2">
                  {isPart ? (
                    <View className="flex-row items-center gap-2">
                      {count === 1 ? (
                        <Button label={words.removeLine} variant="text" disabled={disabled} onPress={() => onRemoveLine?.(line.listingId)} />
                      ) : (
                        <Button label={words.undoLine} variant="text" disabled={disabled} onPress={() => onUndoLine?.(line.listingId)} />
                      )}
                    </View>
                  ) : (
                    <View className="flex-row items-center gap-2">
                      <View className="flex-row items-center rounded-button border border-border-strong">
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={words.reduceCount}
                          disabled={disabled || count === 0}
                          onPress={() => onStepDown?.(line.listingId)}
                          className="size-10 items-center justify-center rounded-full active:bg-primary-subtle"
                        >
                          <Minus size={18} className={disabled || count === 0 ? "text-disabled-text" : "text-primary"} />
                        </Pressable>
                        <Text className="min-w-8 text-center text-label font-semibold tabular-nums text-text">{count}</Text>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={words.increaseCount}
                          disabled={disabled || count >= line.count}
                          onPress={() => onStepUp?.(line.listingId)}
                          className="size-10 items-center justify-center rounded-full active:bg-primary-subtle"
                        >
                          <Plus size={18} className={disabled || count >= line.count ? "text-disabled-text" : "text-primary"} />
                        </Pressable>
                      </View>
                      {count > 0 && (
                        <Button label={words.removeLine} variant="text" disabled={disabled} onPress={() => onRemoveLine?.(line.listingId)} />
                      )}
                      {isReduced && (
                        <Button label={words.undoLine} variant="text" disabled={disabled} onPress={() => onUndoLine?.(line.listingId)} />
                      )}
                    </View>
                  )}
                </View>

                {isReduced && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={reason ? words.lineChangeReasons[reason] : words.reasonSheetTitle}
                    disabled={disabled}
                    onPress={() => onOpenReason?.(line.listingId)}
                    className={`self-start rounded-full px-3 py-1 ${reason ? "border border-border bg-surface" : "border border-warning bg-warning-subtle"}`}
                  >
                    <Text className={`text-secondary font-medium ${reason ? "text-text" : "text-warning-text"}`}>
                      {reason ? words.lineChangeReasons[reason] : words.reasonSheetTitle}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })
        ) : isAwaiting && proposal ? (
          proposal.lines.map((line, index) => {
            const isReduced = line.count < line.originalCount;
            const originalLabel = [
              line.brand,
              line.originalPart
                ? words.part(pack(line.originalPart, line.baseUnit), pack(line.quantity, line.baseUnit))
                : `${line.originalCount} × ${pack(line.quantity, line.baseUnit)}`,
            ].filter(Boolean).join(" · ");
            const proposedLabel = [
              line.brand,
              line.part
                ? words.part(pack(line.part, line.baseUnit), pack(line.quantity, line.baseUnit))
                : `${line.count} × ${pack(line.quantity, line.baseUnit)}`,
            ].filter(Boolean).join(" · ");

            return (
              <View key={index} className={`flex-row gap-3 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
                <View className="flex-1">
                  <Text className="text-body font-semibold text-text">{line.name}</Text>
                  {isReduced ? (
                    <View className="flex-row items-center gap-1.5 flex-wrap">
                      <Text className="text-secondary line-through text-muted tabular-nums">
                        {originalLabel}
                      </Text>
                      <Text className="text-secondary font-medium tabular-nums text-text">
                        {proposedLabel}
                      </Text>
                    </View>
                  ) : (
                    <Text className="text-secondary tabular-nums text-muted">{originalLabel}</Text>
                  )}
                  {isReduced && line.changeReason && (
                    <View className="mt-1 self-start rounded-full border border-border bg-surface px-2.5 py-0.5">
                      <Text className="text-small-label text-muted">{words.lineChangeReasons[line.changeReason]}</Text>
                    </View>
                  )}
                </View>
                <View className="items-end">
                  {isReduced && (
                    <Text className="text-secondary line-through text-muted tabular-nums">
                      {money(line.originalLineTotal)}
                    </Text>
                  )}
                  <Text className="text-label font-semibold tabular-nums text-text">{money(line.lineTotal)}</Text>
                </View>
              </View>
            );
          })
        ) : (
          order.lines.map((line, index) => (
            <View key={index} className={`flex-row gap-3 py-3 ${index > 0 ? "border-t border-border" : ""}`}>
              <View className="flex-1">
                <Text className="text-body font-semibold text-text">{line.name}</Text>
                <Text className="text-secondary tabular-nums text-muted">{lineLabel(line)}</Text>
              </View>
              <Text className="text-label font-semibold tabular-nums text-text">{money(line.lineTotal)}</Text>
            </View>
          ))
        )}
      </View>
      <View className="rounded-card border border-border bg-surface p-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-body font-semibold text-text">{words.collect}</Text>
          <View className="flex-row items-center gap-2">
            {editing && previewTotal ? (
              <>
                <Text className="text-secondary line-through text-muted tabular-nums">
                  {money(previewTotal.originalTotal)}
                </Text>
                <Text className="text-title font-semibold tabular-nums text-text">
                  {money(previewTotal.total)}
                </Text>
              </>
            ) : isAwaiting && proposal ? (
              <>
                <Text className="text-secondary line-through text-muted tabular-nums">
                  {money(proposal.originalTotal)}
                </Text>
                <Text className="text-title font-semibold tabular-nums text-text">
                  {money(proposal.total)}
                </Text>
              </>
            ) : (
              <Text className="text-title font-semibold tabular-nums text-text">{money(order.total)}</Text>
            )}
          </View>
        </View>
        {editing && previewFailed && <Text className="mt-2 text-secondary text-danger">{words.previewFailed}</Text>}
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

function PartialAcceptReasonSheet({
  chosen,
  onChoose,
  onCancel,
}: {
  chosen: OrderLineChangeReason | null;
  onChoose: (reason: OrderLineChangeReason) => void;
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <View className="flex-1 justify-end bg-scrim">
        <View accessibilityViewIsModal className="gap-2 rounded-t-sheet bg-raised px-4 pt-4" style={{ paddingBottom: insets.bottom + 12 }}>
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{words.reasonSheetTitle}</Text>
          <ReasonPicker
            reasons={OrderLineChangeReason.options}
            chosen={chosen}
            words={words.lineChangeReasons}
            onChoose={onChoose}
          />
          <Button label={words.reasonCancel} variant="text" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

/** "Reject this order?" or "Cancel this order?" (#59): a fixed list of reasons; the button stays off until one is chosen (design system, Reason picker). */
function RejectSheet({ sheet, chosen, onChoose, onConfirm, onCancel }: {
  sheet: { title: string; confirm: string; cancel: string };
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
          <Text accessibilityRole="header" className="text-headline font-semibold text-text">{sheet.title}</Text>
          <ReasonPicker reasons={RejectReason.options} chosen={chosen} words={words.reasons} onChoose={onChoose} />
          <Button label={sheet.confirm} disabled={!chosen} onPress={onConfirm} />
          <Button label={sheet.cancel} variant="text" onPress={onCancel} />
        </View>
      </View>
    </Modal>
  );
}

type DeliverersResult = ApiResult<ShopDeliverersResponse> | null;

export default function OrderScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [order] = useState(() => createShopOrder(api, id ?? ""));
  const view = useSyncExternalStore(order.subscribe, order.get);
  useInFront(order);
  const [rejecting, setRejecting] = useState<{ chosen: RejectReason | null } | null>(null);
  const [cancelling, setCancelling] = useState<{ chosen: RejectReason | null } | null>(null);
  const [agreeing, setAgreeing] = useState(false);
  // Known by now: the orders list that led here is the Owner's or Staff's own shop. Only decides what shows; the server refuses Staff.
  const owner = access.role() === "owner";
  const [deliverers, setDeliverers] = useState<DeliverersResult>(null);
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
  const [editing, setEditing] = useState(false);
  const [lineEdits, setLineEdits] = useState<Map<string, { count: number; reason: OrderLineChangeReason | null }>>(() => new Map());
  const [reasonTargetListingId, setReasonTargetListingId] = useState<string | null>(null);
  const previewSeq = useRef(0);
  const [previewState, setPreviewState] = useState<{ key: string; data: PartialAcceptPreviewResponse } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const identity = session.get();
  const accountId = "account" in identity ? identity.account.id : null;
  const shown = view.order;
  const linesRef = useRef(shown?.lines);
  linesRef.current = shown?.lines;
  // Polls hand back a new order object each time; only a change to the lines should redo the preview.
  const linesSig = shown ? shown.lines.map((l) => `${l.listingId}:${l.count}:${l.lineTotal}`).join(",") : "";
  const isNew = shown?.status === "placed";
  const seconds = useSecondsLeft(isNew ? shown.expiresAt : null, view.offset);
  const confirmSeconds = useSecondsLeft(shown?.status === "awaiting_customer_confirm" ? shown.confirmByAt : null, view.offset);
  const failureSeconds = useSecondsLeft(shown?.deliveryFailureReadyAt ?? null, view.offset);
  const timeUp = view.expired || seconds === 0;
  const done = (answered: boolean) => answered && router.replace("/orders");

  function startEditing() {
    if (!shown || submitting || submittingRef.current) return;
    previewSeq.current++;
    setPreviewState(null);
    setPreviewLoading(false);
    const initial = new Map<string, { count: number; reason: OrderLineChangeReason | null }>();
    for (const l of shown.lines) {
      initial.set(l.listingId, { count: l.count, reason: null });
    }
    setLineEdits(initial);
    setEditing(true);
  }

  function cancelEditing() {
    if (submitting || submittingRef.current) return;
    previewSeq.current++;
    setEditing(false);
    setLineEdits(new Map());
    setPreviewState(null);
    setPreviewLoading(false);
    setReasonTargetListingId(null);
  }

  function editableLine(listingId: string) {
    if (!shown || submitting || submittingRef.current) return undefined;
    return shown.lines.find((l) => l.listingId === listingId);
  }

  function onStepDown(listingId: string) {
    const original = editableLine(listingId);
    if (!original) return;
    const edit = lineEdits.get(listingId);
    const currentCount = edit !== undefined ? edit.count : original.count;
    if (currentCount <= 0) return;
    previewSeq.current++;
    setPreviewState(null);
    const newCount = currentCount - 1;
    const existingReason = edit?.reason ?? null;
    const nextEdits = new Map(lineEdits);
    nextEdits.set(listingId, { count: newCount, reason: existingReason });
    setLineEdits(nextEdits);
    if (newCount < original.count && !existingReason) {
      setReasonTargetListingId(listingId);
    }
  }

  function onStepUp(listingId: string) {
    const original = editableLine(listingId);
    if (!original) return;
    const edit = lineEdits.get(listingId);
    const currentCount = edit !== undefined ? edit.count : original.count;
    if (currentCount >= original.count) return;
    previewSeq.current++;
    setPreviewState(null);
    const newCount = currentCount + 1;
    const nextEdits = new Map(lineEdits);
    nextEdits.set(listingId, { count: newCount, reason: newCount === original.count ? null : (edit?.reason ?? null) });
    setLineEdits(nextEdits);
  }

  function onRemoveLine(listingId: string) {
    const original = editableLine(listingId);
    if (!original) return;
    const edit = lineEdits.get(listingId);
    const existingReason = edit?.reason ?? null;
    previewSeq.current++;
    setPreviewState(null);
    const nextEdits = new Map(lineEdits);
    nextEdits.set(listingId, { count: 0, reason: existingReason });
    setLineEdits(nextEdits);
    if (!existingReason) {
      setReasonTargetListingId(listingId);
    }
  }

  function onUndoLine(listingId: string) {
    const original = editableLine(listingId);
    if (!original) return;
    previewSeq.current++;
    setPreviewState(null);
    const nextEdits = new Map(lineEdits);
    nextEdits.set(listingId, { count: original.count, reason: null });
    setLineEdits(nextEdits);
    if (reasonTargetListingId === listingId) {
      setReasonTargetListingId(null);
    }
  }

  function onSelectReason(reason: OrderLineChangeReason) {
    if (!reasonTargetListingId || submitting || submittingRef.current) return;
    const edit = lineEdits.get(reasonTargetListingId);
    if (edit) {
      previewSeq.current++;
      setPreviewState(null);
      const nextEdits = new Map(lineEdits);
      nextEdits.set(reasonTargetListingId, { count: edit.count, reason });
      setLineEdits(nextEdits);
    }
    setReasonTargetListingId(null);
  }

  useEffect(() => {
    return () => {
      previewSeq.current++;
    };
  }, []);

  const canEditOrder = shown?.status === "placed" || shown?.status === "accepted" || shown?.status === "preparing";
  // `submitting` is a dependency on purpose: cancelEditing refuses while Send is in flight, so the effect must run again once it ends.
  useEffect(() => {
    if (editing && !canEditOrder) {
      cancelEditing();
    }
  }, [editing, canEditOrder, submitting]);

  useEffect(() => {
    if (!editing || !linesRef.current) {
      previewSeq.current++;
      setPreviewFailed(false);
      setPreviewState(null);
      setPreviewLoading(false);
      return;
    }
    const lines = linesRef.current ?? [];
    const currentKey = proposalKey(lines, lineEdits);
    if (!currentKey) {
      previewSeq.current++;
      setPreviewFailed(false);
      setPreviewState(null);
      setPreviewLoading(false);
      return;
    }

    const proposed: PartialAcceptLine[] = [];
    for (const l of lines) {
      const edit = lineEdits.get(l.listingId);
      const count = edit !== undefined ? edit.count : l.count;
      if (count < l.count) {
        proposed.push({
          listingId: l.listingId,
          count,
          reason: edit?.reason ?? "out_of_stock",
        });
      }
    }

    setPreviewLoading(true);
    setPreviewFailed(false);
    const reqId = ++previewSeq.current;
    const timer = setTimeout(() => {
      void order
        .previewPartialAccept(proposed)
        .then((result) => {
          if (reqId !== previewSeq.current) return;
          setPreviewLoading(false);
          if (result && result.ok) {
            setPreviewState({ key: currentKey, data: result.data });
          } else {
            setPreviewState(null);
            setPreviewFailed(true);
          }
        })
        .catch(() => {
          if (reqId !== previewSeq.current) return;
          setPreviewLoading(false);
          setPreviewState(null);
          setPreviewFailed(true);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
    };
  }, [editing, lineEdits, linesSig, order]);

  let hasChanges = false;
  let remainingCount = 0;
  let allReducedHaveReasons = true;
  if (shown) {
    const lines = shown.lines ?? [];
    for (const l of lines) {
      const edit = lineEdits.get(l.listingId);
      const count = edit !== undefined ? edit.count : l.count;
      if (count < l.count) {
        hasChanges = true;
        if (!edit?.reason) {
          allReducedHaveReasons = false;
        }
      }
      if (count > 0) remainingCount++;
    }
  }

  const currentKey = shown ? proposalKey(shown.lines ?? [], lineEdits) : null;
  const previewMatchesCurrent = previewState !== null && currentKey !== null && previewState.key === currentKey;
  const previewTotal = previewMatchesCurrent ? previewState.data : null;

  const canSend =
    hasChanges &&
    remainingCount > 0 &&
    allReducedHaveReasons &&
    previewMatchesCurrent &&
    !previewLoading &&
    !submitting &&
    !timeUp;

  async function handleSendNewTotal() {
    if (!shown || !canSend || submitting || submittingRef.current) return;
    const keyAtSend = proposalKey(shown.lines ?? [], lineEdits);
    if (!keyAtSend || previewState?.key !== keyAtSend) return;
    const proposed: PartialAcceptLine[] = [];
    const lines = shown.lines ?? [];
    for (const l of lines) {
      const edit = lineEdits.get(l.listingId);
      const count = edit !== undefined ? edit.count : l.count;
      if (count < l.count) {
        if (!edit?.reason) return;
        proposed.push({
          listingId: l.listingId,
          count,
          reason: edit.reason,
        });
      }
    }
    if (proposed.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const ok = await order.partialAccept(proposed);
      if (ok) {
        previewSeq.current++;
        setEditing(false);
        setLineEdits(new Map());
        setPreviewState(null);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

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
        {shown?.status === "awaiting_customer_confirm" && (
          <View className="gap-2 rounded-card border border-warning bg-warning-subtle p-4">
            <Text className="text-body font-semibold text-warning-text">{words.waitingForConfirm}</Text>
            {confirmSeconds !== null && <Countdown seconds={confirmSeconds} />}
          </View>
        )}
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
        {shown && ["accepted", "preparing"].includes(shown.status) && shown.cancelRequest?.status === "asked" && (
          <View className="gap-2 rounded-card border border-border bg-surface p-4">
            <Text className="text-body font-semibold text-text">{words.askedTitle}</Text>
            <Text className="text-secondary text-muted">{words.askedBody}</Text>
            <Button label={view.answering === "agree" ? words.agreeing : words.agree} variant="secondary" busy={view.answering === "agree"} disabled={view.answering !== null} onPress={() => setAgreeing(true)} />
            <Button label={view.answering === "keep" ? words.keeping : words.keepOrder} busy={view.answering === "keep"} disabled={view.answering !== null} onPress={() => void order.keep()} />
          </View>
        )}
        {shown && (
          <Detail
            order={shown}
            editing={editing}
            lineEdits={lineEdits}
            disabled={submitting}
            onStepDown={onStepDown}
            onStepUp={onStepUp}
            onRemoveLine={onRemoveLine}
            onUndoLine={onUndoLine}
            onOpenReason={(listingId) => {
              if (!submitting && !submittingRef.current) {
                setReasonTargetListingId(listingId);
              }
            }}
            previewTotal={previewTotal}
            previewFailed={previewFailed}
          />
        )}
        {shown && ["accepted", "preparing"].includes(shown.status) && access.role() !== null && !editing && (
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label={words.acceptInPart} variant="secondary" onPress={startEditing} />
            </View>
            <View className="flex-1">
              <Button
                label={view.answering === "cancel" ? words.cancelling : words.cancelOrder}
                variant="secondary"
                busy={view.answering === "cancel"}
                disabled={view.answering !== null}
                onPress={() => setCancelling({ chosen: null })}
              />
            </View>
          </View>
        )}
        {shown && shown.status === "ready" && access.role() !== null && !editing && (
          <Button
            label={view.answering === "cancel" ? words.cancelling : words.cancelOrder}
            variant="secondary"
            busy={view.answering === "cancel"}
            disabled={view.answering !== null}
            onPress={() => setCancelling({ chosen: null })}
          />
        )}
        {shown && !editing && (["accepted", "preparing"].includes(shown.status) || (shown.status === "ready" && owner)) && <View className="gap-2">
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

      {editing ? (
        <View className="gap-2.5 border-t border-border bg-surface px-4 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
          <Button
            label={submitting ? words.sendingNewTotal : words.sendNewTotal}
            disabled={!canSend || submitting}
            busy={submitting}
            onPress={() => void handleSendNewTotal()}
          />
          <Button
            label={words.cancelChanges}
            variant="secondary"
            disabled={submitting}
            onPress={cancelEditing}
          />
        </View>
      ) : isNew ? (
        <View className="gap-2.5 border-t border-border bg-surface px-4 pt-3" style={{ paddingBottom: insets.bottom + 12 }}>
          <Button
            label={view.answering === "reject" ? words.rejecting : words.reject}
            variant="destructive-outline"
            busy={view.answering === "reject"}
            disabled={timeUp || view.answering !== null}
            // After NOT_ENOUGH_STOCK, "Items out of stock" is the likely reason (owner's answer 8 on #431).
            onPress={() => setRejecting({ chosen: view.shortLines.length > 0 ? "out_of_stock" : null })}
          />
          <Button
            label={words.acceptInPart}
            variant="secondary"
            disabled={timeUp || view.answering !== null}
            onPress={startEditing}
          />
          <Button
            label={view.answering === "accept" ? words.accepting : words.accept}
            busy={view.answering === "accept"}
            disabled={timeUp || view.answering !== null}
            onPress={() => void order.accept().then(done)}
          />
        </View>
      ) : null}
      {cancelling && (
        <RejectSheet
          sheet={words.cancelSheet}
          chosen={cancelling.chosen}
          onChoose={(chosen) => setCancelling({ chosen })}
          onCancel={() => setCancelling(null)}
          onConfirm={() => {
            if (!cancelling.chosen) return;
            const reason = cancelling.chosen;
            setCancelling(null);
            void order.cancel(reason);
          }}
        />
      )}
      <Confirm
        visible={agreeing}
        title={words.agreeTitle}
        body={words.agreeBody}
        confirm={words.agree}
        cancel={words.keepOrder}
        onConfirm={() => {
          setAgreeing(false);
          void order.agree();
        }}
        onCancel={() => setAgreeing(false)}
      />
      {rejecting && (
        <RejectSheet
          sheet={words.sheet}
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
      {reasonTargetListingId && !submitting && (
        <PartialAcceptReasonSheet
          chosen={lineEdits.get(reasonTargetListingId)?.reason ?? null}
          onChoose={onSelectReason}
          onCancel={() => setReasonTargetListingId(null)}
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
