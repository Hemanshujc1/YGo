import type { createAdminApiClient } from "@ygo/api-client";
import { ForceTransitionBody, TERMINAL_ORDER_STATUSES, type AdminOrderDetail, type ForcedOrderStatus } from "@ygo/contracts";
import { formatDateTime, formatMoney, trimDecimal } from "@ygo/format";
import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import { OrderStatusPill } from "./components/order-status-pill";
import { ReasonDialog } from "./components/reason-dialog";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;

const humanKey = (key: string) => key.replace(/([A-Z])/g, " $1").toLowerCase();

/**
 * A15 Order detail and forced transition (ADM-4, ORD-1, MNY-7, #66). Lines and money are shown as frozen at placement. Admin may close a stuck
 * order from the moves the server offers for its status, with a required reason. An Area Manager only looks (ADM-12): the server offers them no move.
 */
export function OrderDetail({ api }: { api: AdminApi }) {
  const [detail, setDetail] = useState(useLoaderData() as AdminOrderDetail);
  const [target, setTarget] = useState<ForcedOrderStatus | "">("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reasonError, setReasonError] = useState<string>();
  const [error, setError] = useState<string>();
  const { order, money, breakdown } = detail;
  const role = api.currentRole();
  const status = (value: string) => strings.orderStatuses[value as keyof typeof strings.orderStatuses] ?? value;

  async function force(reason: string) {
    if (busy || !target) return;
    const body = ForceTransitionBody.safeParse({ from: order.status, to: target, reason });
    if (!body.success) return setReasonError(strings.orderForceReasonRequired);
    setReasonError(undefined);
    setError(undefined);
    setBusy(true);
    try {
      const answer = await api.forceOrderTransition(order.id, body.data);
      if (answer.ok) {
        setDetail(answer.data);
        setTarget("");
        return setConfirming(false);
      }
      if (answer.code === "ORDER_STATUS_CHANGED" || answer.code === "ORDER_MOVE_NOT_ALLOWED") {
        // Show the order as it is now, with the moves it really allows.
        const fresh = await api.getAdminOrder(order.id);
        if (fresh.ok) setDetail(fresh.data);
        setTarget("");
        setConfirming(false);
        return setError(answer.code === "ORDER_STATUS_CHANGED" ? strings.orderForceStale : strings.errors[answer.code]);
      }
      setError(strings.errors[answer.code]);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <Link to="/orders" className="text-primary underline">{strings.orderDetailBack}</Link>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <h1 className="text-title-large font-semibold">{strings.orderDetailNumber(order.number)}</h1>
      <OrderStatusPill status={order.status} />
      {order.unanswered && <span className="font-medium text-danger">{strings.liveOrdersUnansweredTag}</span>}
    </div>
    <p className="mt-2 text-muted">{order.shopName} · {strings.fulfilment[order.fulfilment]} · {strings.orderDetailPlaced(formatDateTime(order.placedAt))} · {strings.orderDetailInStatus(strings.orderAge(order.statusAgeSeconds))}</p>
    {error && <p role="alert" className="mt-4 text-danger">{error}</p>}

    <section aria-labelledby="order-lines" className="mt-8 rounded-xl border border-border bg-surface">
      <h2 id="order-lines" className="p-4 font-semibold">{strings.orderDetailLines}</h2>
      <div className="overflow-x-auto"><table className="w-full min-w-xl text-left">
        <thead className="bg-sunken"><tr>{Object.values(strings.orderDetailLineColumns).map((label) => <th key={label} scope="col" className="p-3 font-medium">{label}</th>)}</tr></thead>
        <tbody>{detail.lines.map((line, index) => <tr key={index} className="border-t border-border">
          <td className="p-3">{line.name}{line.brand ? <span className="text-muted"> · {line.brand}</span> : null}</td>
          <td className="p-3 tabular-nums">{line.partQuantity ? `${trimDecimal(line.partQuantity)} of ` : ""}{trimDecimal(line.packQuantity)} {line.baseUnit}</td>
          <td className="p-3 tabular-nums">{line.count}</td>
          <td className="p-3 tabular-nums">{formatMoney(line.unitPrice)}</td>
          <td className="p-3 tabular-nums">{formatMoney(line.lineTotal)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>

    <div className="mt-6 grid gap-6 md:grid-cols-2">
      <section aria-labelledby="order-money" className="rounded-xl border border-border bg-surface p-4">
        <h2 id="order-money" className="mb-2 font-semibold">{strings.orderDetailMoney}</h2>
        <dl className="space-y-1">
          {([
            [strings.orderDetailProductValue, money.productValue],
            [strings.orderDetailShopDiscount, money.shopDiscount],
            [strings.orderDetailDeliveryFee, money.deliveryFee],
            [strings.orderDetailSmallCartFee, money.smallCartFee],
            [strings.orderDetailPickupFee, money.pickupFee],
          ] as const).filter(([, value]) => value !== null).map(([label, value]) => <div key={label} className="flex justify-between gap-3">
            <dt className="text-muted">{label}</dt><dd className="tabular-nums">{formatMoney(value as string)}</dd></div>)}
          <div className="flex justify-between gap-3 border-t border-border pt-1 font-semibold"><dt>{strings.orderDetailTotal}</dt><dd className="tabular-nums">{formatMoney(money.total)}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="order-breakdown" className="rounded-xl border border-border bg-surface p-4">
        <h2 id="order-breakdown" className="mb-2 font-semibold">{strings.orderDetailBreakdown}</h2>
        {!breakdown ? <p className="text-muted">{strings.orderDetailBreakdownMissing}</p> : <>
          <p className="text-muted">{strings.orderDetailRateCard(breakdown.rateCardVersion)}</p>
          <dl className="mt-2 space-y-1">
            <div className="flex justify-between gap-3"><dt className="text-muted">{strings.orderDetailCommission}</dt><dd className="tabular-nums">{formatMoney(breakdown.commission)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">{strings.orderDetailShopKeeps}</dt><dd className="tabular-nums">{formatMoney(breakdown.shopKeeps)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">{strings.orderDetailContribution}</dt><dd className="tabular-nums">{formatMoney(breakdown.platformContribution)}</dd></div>
          </dl>
          <ul className="mt-2 space-y-1">
            <li>{strings.orderDetailFeeShare(strings.orderDetailDeliveryFee, formatMoney(breakdown.deliveryFee.platformShare), formatMoney(breakdown.deliveryFee.shopShare))}</li>
            {breakdown.smallCartFee && <li>{strings.orderDetailFeeShare(strings.orderDetailSmallCartFee, formatMoney(breakdown.smallCartFee.platformShare), formatMoney(breakdown.smallCartFee.shopShare))}</li>}
            {breakdown.reasons.map((reason) => <li key={reason.code} className="text-danger">{strings.orderDetailReasons[reason.code]}: {formatMoney(reason.shortfall)}</li>)}
          </ul>
          {Object.keys(breakdown.sources).length > 0 && <><h3 className="mt-3 font-medium">{strings.orderDetailSources}</h3>
            <ul className="mt-1 space-y-1 text-secondary text-muted">{Object.entries(breakdown.sources).map(([key, source]) => <li key={key}>{strings.orderDetailSource(humanKey(key), source.type, source.version)}</li>)}</ul></>}
        </>}
      </section>
    </div>

    <section aria-labelledby="order-people" className="mt-6 rounded-xl border border-border bg-surface p-4">
      <h2 id="order-people" className="mb-2 font-semibold">{strings.orderDetailPeople}</h2>
      <dl className="space-y-1">
        <div className="flex gap-3"><dt className="w-40 text-muted">{strings.orderDetailCustomer}</dt><dd>{detail.people.customerName ?? strings.orderDetailUnnamed}</dd></div>
        <div className="flex gap-3"><dt className="w-40 text-muted">{strings.orderDetailDeliverer}</dt><dd>{detail.people.delivererName ?? strings.orderDetailUnnamed}</dd></div>
      </dl>
    </section>

    <section aria-labelledby="order-timeline" className="mt-6 rounded-xl border border-border bg-surface p-4">
      <h2 id="order-timeline" className="mb-2 font-semibold">{strings.orderDetailTimeline}</h2>
      <ol className="space-y-2">{detail.timeline.map((step, index) => <li key={index}>
        <span className="tabular-nums text-muted"><time dateTime={step.at}>{formatDateTime(step.at)}</time></span>{" · "}
        <span className="font-medium">{step.from ? strings.orderDetailTimelineStep(status(step.from), status(step.to)) : `${strings.orderDetailTimelineStart}: ${status(step.to)}`}</span>{" · "}
        <span>{step.actorName ? `${step.actorName}, ` : ""}{strings.orderDetailActor[step.actorRole]}</span>
      </li>)}</ol>
      {detail.forcedActions.length > 0 && <ul className="mt-4 space-y-2 border-t border-border pt-3">{detail.forcedActions.map((action, index) => <li key={index}>
        <p className="font-medium">{strings.orderDetailForcedBy(action.adminName, formatDateTime(action.at))}: {strings.orderDetailTimelineStep(status(action.from), status(action.to))}</p>
        <p className="text-muted">{action.reason}</p></li>)}</ul>}
    </section>

    {role === "admin" ? <section aria-labelledby="order-force" className="mt-6 rounded-xl border border-border bg-surface p-4">
      <h2 id="order-force" className="font-semibold">{strings.orderForceTitle}</h2>
      {detail.forcedMoves.length === 0
        ? <p className="mt-2 text-muted">{TERMINAL_ORDER_STATUSES.includes(order.status) ? strings.orderForceNone : strings.orderForceNoneOpen}</p>
        : <>
          <p className="mt-2 text-muted">{strings.orderForceIntro}</p>
          <p className="mt-2">{strings.orderForceCurrent(status(order.status))}</p>
          <fieldset className="mt-3"><legend className="mb-2 font-medium">{strings.orderForceChoose}</legend>
            <div className="space-y-2">{detail.forcedMoves.map((move) => <label key={move} className="flex items-center gap-2">
              <input type="radio" name="forced-move" value={move} checked={target === move} onChange={() => setTarget(move)} />{status(move)}</label>)}</div>
          </fieldset>
          <button disabled={!target} onClick={() => { setError(undefined); setReasonError(undefined); setConfirming(true); }} className="mt-4 h-10 rounded-lg bg-danger px-4 font-medium text-on-danger disabled:opacity-60">{strings.orderForceStart}</button>
        </>}
    </section> : <p className="mt-6 text-muted">{strings.orderForceViewOnly}</p>}

    {confirming && target && <ReasonDialog title={strings.orderForceConfirmTitle(order.number, status(order.status), status(target))} note={strings.orderForceNote}
      confirmLabel={strings.orderForceConfirm} danger busy={busy} reasonError={reasonError} error={error} onConfirm={(reason) => void force(reason)} onCancel={() => setConfirming(false)} />}
  </>;
}
