import { formatMoney } from "@ygo/format";

/** A server amount such as "59.50", shown with no trailing zeros (#413). */
export const money = (amount: string) => formatMoney(Number(amount));
