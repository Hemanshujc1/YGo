/** Rupees with at most two decimals, such as "-12.5", as integer paise (ADR-0007). */
export function toPaise(amount: string): bigint {
  const isNegative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (isNegative ? amount.slice(1) : amount).split(".");
  const paise = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return isNegative ? -paise : paise;
}

/** Integer paise as rupees with two decimals, such as "-12.50". */
export function fromPaise(paise: bigint): string {
  const abs = paise < 0n ? -paise : paise;
  return `${paise < 0n ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
