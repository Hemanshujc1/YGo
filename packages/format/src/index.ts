const locale = "en-IN";
const timeZone = "Asia/Kolkata";

const indianNumber = new Intl.NumberFormat(locale);
const indianMoney = new Intl.NumberFormat(locale, {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const indianDate = new Intl.DateTimeFormat(locale, {
  timeZone,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const indianTime = new Intl.DateTimeFormat(locale, {
  timeZone,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export const formatNumber = (value: number | bigint) => indianNumber.format(value);

// Only format() is used: Hermes on iOS has no NumberFormat.formatToParts.

// The only hyphen in a rupee amount is its sign, shown as a true minus.
// Android puts a space after ₹ and iOS does not; the design system has none.
export const formatMoney = (value: number | bigint) =>
  indianMoney.format(value).replace("-", "−").replace(/₹\s/, "₹");

export const formatDate = (value: Date | string | number) => indianDate.format(new Date(value));

// The time holds only digits, a colon, a space and the day period, so upper case touches only "am" or "pm".
export const formatTime = (value: Date | string | number) =>
  indianTime.format(new Date(value)).toUpperCase();

export const formatDateTime = (value: Date | string | number) =>
  `${formatDate(value)}, ${formatTime(value)}`;

// "+919876543210", as `Phone` in @ygo/contracts stores it, shows as "98765 43210". Anything else shows as stored.
export const formatPhone = (value: string) => {
  const indian = /^\+91([6-9]\d{4})(\d{5})$/.exec(value);
  return indian ? `${indian[1]} ${indian[2]}` : value;
};
