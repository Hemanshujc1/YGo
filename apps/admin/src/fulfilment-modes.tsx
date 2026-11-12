import type { createAdminApiClient } from "@ygo/api-client";
import type { AdminShopApplication, FulfilmentMode, FulfilmentModeState } from "@ygo/contracts";
import { useEffect, useState } from "react";
import { Link, useLoaderData } from "react-router";
import { strings } from "./strings";

type AdminApi = ReturnType<typeof createAdminApiClient>;

/** A shop's fulfilment modes with its own switch beside Admin's force-off, so forcing one off or lifting it never touches the shop's choice (FUL-1, #65). */
export function FulfilmentModes({ api }: { api: AdminApi }) {
  const application = useLoaderData() as AdminShopApplication;
  const [modes, setModes] = useState<FulfilmentModeState[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<FulfilmentMode | null>(null);

  async function load() {
    setLoadError("");
    try {
      const result = await api.shopFulfilmentModes(application.id);
      if (result.ok) setModes(result.data.modes);
      else setLoadError(strings.errors[result.code]);
    } catch { setLoadError(strings.failed); }
  }

  useEffect(() => { void load(); }, [application.id]);

  async function force(mode: FulfilmentMode, forcedOff: boolean) {
    setBusy(mode); setError("");
    try {
      const result = await api.forceFulfilmentMode(application.id, mode, forcedOff);
      if (result.ok) setModes(result.data.modes);
      else setError(strings.errors[result.code]);
    } catch { setError(strings.failed); }
    finally { setBusy(null); }
  }

  return <>
    <div className="mb-8">
      <Link to={`/applications/${application.id}`} className="text-primary underline">{strings.backToShop}</Link>
      <h1 className="mt-3 text-title-large font-semibold">{application.shopName ? strings.fulfilmentOf(application.shopName) : strings.fulfilmentLink}</h1>
      <p className="mt-2 text-muted">{strings.fulfilmentIntro}</p>
    </div>
    {error && <p role="alert" className="mb-4 rounded-lg bg-danger-subtle p-3 text-on-danger-subtle">{error}</p>}
    {loadError ? <div><p role="alert" className="text-danger">{loadError}</p>
      <button onClick={() => void load()} className="mt-4 h-10 rounded-lg border border-border-strong px-4 text-primary">{strings.retry}</button></div>
      : !modes ? <p className="text-muted">{strings.fulfilmentLoading}</p>
      : <ul className="space-y-4">{modes.map((state) => {
        const name = strings.fulfilmentModeNames[state.mode];
        return <li key={state.mode} aria-label={name} className="rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">{name}</h2>
            <span className={`rounded-lg px-2 py-1 font-medium ${state.open ? "bg-success-subtle text-on-success-subtle" : "bg-sunken text-muted"}`}>{state.open ? strings.fulfilmentOpen : strings.fulfilmentClosed}</span>
          </div>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            <div><dt className="text-muted">{strings.fulfilmentShopSwitch}</dt><dd className="font-medium">{state.shopOn ? strings.fulfilmentOn : strings.fulfilmentOff}</dd></div>
            <div><dt className="text-muted">{strings.fulfilmentAdmin}</dt><dd className="font-medium">{state.adminForcedOff ? strings.fulfilmentForced : strings.fulfilmentNotForced}</dd></div>
          </dl>
          <div className="mt-4">{state.adminForcedOff
            ? <button disabled={busy !== null} aria-label={strings.fulfilmentRestoreOf(name)} onClick={() => void force(state.mode, false)} className="h-10 rounded-lg border border-border-strong px-4 disabled:opacity-60">{busy === state.mode ? strings.saving : strings.fulfilmentRestore}</button>
            : <button disabled={busy !== null} aria-label={strings.fulfilmentForceOffOf(name)} onClick={() => void force(state.mode, true)} className="h-10 rounded-lg bg-danger px-4 font-medium text-on-danger disabled:opacity-60">{busy === state.mode ? strings.saving : strings.fulfilmentForceOff}</button>}</div>
        </li>;
      })}</ul>}
  </>;
}
