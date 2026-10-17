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

export const formatMoney = (value: number | bigint) =>
  indianMoney
    .formatToParts(value)
    .map((part) => (part.type === "minusSign" ? "−" : part.value))
    .join("");

export const formatDate = (value: Date | string | number) => indianDate.format(new Date(value));

export const formatTime = (value: Date | string | number) =>
  indianTime
    .formatToParts(new Date(value))
    .map((part) => (part.type === "dayPeriod" ? part.value.toUpperCase() : part.value))
    .join("");

export const formatDateTime = (value: Date | string | number) =>
  `${formatDate(value)}, ${formatTime(value)}`;
