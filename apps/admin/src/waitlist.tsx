import type { WaitlistEntry } from "@ygo/contracts";
import { formatDateTime, formatPhone } from "@ygo/format";
import { useLoaderData } from "react-router";
import { strings } from "./strings";

export function Waitlist() {
  const entries = useLoaderData() as WaitlistEntry[];
  return <>
    <h1 className="text-title-large font-semibold">{strings.waitlist}</h1>
    <p className="mt-2 text-muted">{strings.waitlistIntro}</p>
    <section className="mt-8 rounded-xl border border-border bg-surface p-6">
      {entries.length === 0 ? <p className="text-muted">{strings.noWaitlist}</p> : <div className="overflow-x-auto">
        <table className="w-full min-w-3xl text-left">
          <thead className="bg-sunken"><tr>
            {[strings.callbackPhone, strings.pincode, strings.waitlistAccount, strings.lastCaptured].map((label) =>
              <th key={label} scope="col" className="p-3 font-medium">{label}</th>)}
          </tr></thead>
          <tbody>{entries.map((entry) => <tr key={`${entry.accountId}:${entry.pincode}`} className="border-t border-border">
            <td className="p-3 tabular-nums">{formatPhone(entry.phone)}</td>
            <td className="p-3 tabular-nums">{entry.pincode}</td>
            <td className="p-3">{entry.accountName && <p className="font-medium">{entry.accountName}</p>}<p>{entry.accountEmail}</p></td>
            <td className="p-3 tabular-nums"><time dateTime={entry.savedAt}>{formatDateTime(entry.savedAt)}</time></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  </>;
}
