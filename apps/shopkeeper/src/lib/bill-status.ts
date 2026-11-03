import { SyncActionCode } from "@ygo/contracts";
import { strings } from "../strings";
import { voidedLine } from "./counter-bill-voids";
import type { BillRow } from "./opening-stock-queue";

/** Today's bills and S08's Synced today start at midnight on this phone. */
export function startOfToday(now = new Date()) { return new Date(now.getFullYear(), now.getMonth(), now.getDate()); }

/** A bill's one status line on the Bill screen and S08 (#468): only a held bill warns, and only a refused or voided one is in danger. */
export function billStatus(bill: Pick<BillRow, "status" | "number" | "code" | "voided">): { text: string; tone: "muted" | "warning" | "danger" } {
  const words = strings.bill.status;
  // A void replaces "Synced · Bill 12": the server says it, and only a numbered bill can be voided (#493).
  if (bill.status === "synced" && bill.number !== null && bill.voided) return { text: voidedLine(bill.voided), tone: "danger" };
  if (bill.status === "synced" && bill.number !== null) return { text: words.synced(bill.number), tone: "muted" };
  if (bill.status === "held") return { text: words.held, tone: "warning" };
  if (bill.status === "refused") {
    const code = SyncActionCode.safeParse(bill.code);
    return { text: words.refused(strings.sync.reasons[code.success ? code.data : "VALIDATION_FAILED"]), tone: "danger" };
  }
  return { text: words.pending, tone: "muted" };
}
