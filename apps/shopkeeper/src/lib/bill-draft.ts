import { BillAmount, CounterBillLine, CounterBillManualLine, CounterBillPayload, Phone } from "@ygo/contracts";
import { counterBillTotal } from "@ygo/pricing";

/** A typed line as the shopkeeper types it: name, price each and count, all still text. */
export type TypedLine = { key: string; name: string; price: string; count: string };
export type BillCustomer = { name: string; phone: string; offers: boolean };
export type DraftInput = {
  lines: Array<{ packId: string; unitPrice: string; count: string }>;
  typed: TypedLine[];
  discount: string;
  customer: BillCustomer;
  payment: "cash" | "upi" | null;
};
export type DraftProblems = {
  /** A catalog line's count is not 1 to 9,999. */
  counts: boolean;
  /** Each typed line's first wrong field, by its key. */
  typed: Record<string, "name" | "price" | "count">;
  discount: "format" | "tooBig" | null;
  customerName: boolean;
  phone: boolean;
};

const countOf = (count: string) => Number(count);
const countFits = (count: string) => CounterBillLine.shape.count.safeParse(countOf(count)).success;

/**
 * The Bill screen's form checked with the contract's rules (#53): each field's problem, the lines' sum and total
 * when every line reads, and the payload to queue when nothing is wrong. Empty discount and customer fields are left out.
 * The offers tick counts only beside a readable phone, since the server refuses it without one.
 */
export function draftBill(input: DraftInput): { sum: string | null; total: string | null; discount: string; problems: DraftProblems; payload: CounterBillPayload | null } {
  const typed: DraftProblems["typed"] = {};
  for (const line of input.typed) {
    const field = !CounterBillManualLine.shape.name.safeParse(line.name).success ? "name"
      : !CounterBillManualLine.shape.unitPrice.safeParse(line.price).success ? "price" : !countFits(line.count) ? "count" : null;
    if (field) typed[line.key] = field;
  }
  const counts = !input.lines.every((line) => countFits(line.count));
  const discount = input.discount.trim();
  const discountReads = discount === "" || BillAmount.safeParse(discount).success;
  const amounts = [...input.lines.map((line) => ({ unitPrice: line.unitPrice, count: countOf(line.count) })),
    ...input.typed.map((line) => ({ unitPrice: line.price.trim(), count: countOf(line.count) }))];
  const sum = !counts && Object.keys(typed).length === 0 ? counterBillTotal(amounts) : null;
  const total = sum !== null && discountReads ? counterBillTotal(amounts, discount || "0") : null;

  const name = input.customer.name.trim(), phone = input.customer.phone.trim();
  const readPhone = Phone.safeParse(phone);
  const problems: DraftProblems = {
    counts, typed,
    discount: !discountReads ? "format" : sum !== null && total === null ? "tooBig" : null,
    customerName: name !== "" && !CounterBillManualLine.shape.name.safeParse(name).success,
    phone: phone !== "" && !readPhone.success,
  };
  const wrong = counts || Object.keys(typed).length > 0 || problems.discount !== null || problems.customerName || problems.phone;
  if (wrong || total === null || !input.payment || input.lines.length + input.typed.length === 0) return { sum, total, discount, problems, payload: null };

  const bill = CounterBillPayload.safeParse({
    lines: input.lines.map((line) => ({ packId: line.packId, count: countOf(line.count), unitPrice: line.unitPrice })),
    ...(input.typed.length > 0 && { manualLines: input.typed.map((line) => ({ name: line.name, count: countOf(line.count), unitPrice: line.price })) }),
    ...(discount !== "" && Number(discount) > 0 && { discount }),
    ...((name !== "" || phone !== "") && { customer: { ...(name !== "" && { name }), ...(phone !== "" && { phone }), offers: input.customer.offers && readPhone.success } }),
    total, payment: input.payment,
  });
  return { sum, total, discount, problems, payload: bill.success ? bill.data : null };
}
