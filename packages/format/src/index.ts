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
export const formatMoney = (value: number | bigint) => indianMoney.format(value).replace("-", "−");

export const formatDate = (value: Date | string | number) => indianDate.format(new Date(value));

// The time holds only digits, a colon, a space and the day period, so upper case touches only "am" or "pm".
export const formatTime = (value: Date | string | number) =>
  indianTime.format(new Date(value)).toUpperCase();

export const formatDateTime = (value: Date | string | number) =>
  `${formatDate(value)}, ${formatTime(value)}`;
