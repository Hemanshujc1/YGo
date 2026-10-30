import { formatMoney } from "@ygo/format";

/** Display only: the server keeps every amount exact, and this only shows it (ADR-0004). */
export const money = (amount: string) => formatMoney(Number(amount));
