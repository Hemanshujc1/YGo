import { SyncActionCode } from "@ygo/contracts";
import { strings } from "../strings";
import type { BillRow } from "./opening-stock-queue";

/** A bill's one status line on the Bill screen and S08 (#468): only a held bill warns, and only a refused one is in danger. */
export function billStatus(bill: Pick<BillRow, "status" | "number" | "code">): { text: string; tone: "muted" | "warning" | "danger" } {
  const words = strings.bill.status;
  if (bill.status === "synced" && bill.number !== null) return { text: words.synced(bill.number), tone: "muted" };
  if (bill.status === "held") return { text: words.held, tone: "warning" };
  if (bill.status === "refused") {
    const code = SyncActionCode.safeParse(bill.code);
    return { text: words.refused(strings.sync.reasons[code.success ? code.data : "VALIDATION_FAILED"]), tone: "danger" };
  }
  return { text: words.pending, tone: "muted" };
}
