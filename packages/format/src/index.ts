const locale = "en-IN";
const timeZone = "Asia/Kolkata";

const indianNumber = new Intl.NumberFormat(locale);
const indianMoney = new Intl.NumberFormat(locale, {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const indianWholeMoney = new Intl.NumberFormat(locale, {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
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
const tidyMoney = (text: string) => text.replace("-", "−").replace(/₹\s/, "₹");

// Always two decimals (₹60.00), for Admin and for bills and other columns of amounts that line up (#413).
export const formatMoneyFixed = (value: number | bigint) => tidyMoney(indianMoney.format(value));

// The rule everywhere else: ₹60 for whole rupees, ₹59.50 with paise, never ".00" (#413).
export const formatMoney = (value: number | bigint) =>
  Number.isInteger(Number(value)) ? tidyMoney(indianWholeMoney.format(value)) : formatMoneyFixed(value);

export const formatDate = (value: Date | string | number) => indianDate.format(new Date(value));

// The time holds only digits, a colon, a space and the day period, so upper case touches only "am" or "pm".
export const formatTime = (value: Date | string | number) =>
  indianTime.format(new Date(value)).toUpperCase();

// A time of day held as minutes past midnight in India, as opening hours store it (#371): 540 is "9:00 AM".
export const formatMinuteOfDay = (minutes: number) => formatTime(Date.UTC(2000, 0, 1, 0, minutes - 330));

const indianWeekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: "short" });

// The short weekday in India: "Tue".
export const formatWeekday = (value: Date | string | number) => indianWeekday.format(new Date(value));

const indianDayMonth = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" });

// The day and short month in India: "12 Nov" (#382).
export const formatDayMonth = (value: Date | string | number) => indianDayMonth.format(new Date(value));

const indianDayMonthYear = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short", year: "numeric" });

// With the year, for a record that can reach back past this year: "12 Nov 2029" (#382).
export const formatDayMonthYear = (value: Date | string | number) => indianDayMonthYear.format(new Date(value));

const DAY = 24 * 60 * 60_000;
const indiaDay = (at: number) => Math.floor((at + 330 * 60_000) / DAY);

// When something happens, from `now`, in India: "9:00 PM" today, "tomorrow 9:00 AM", "Tue 9:00 AM"
// within the week (#380, #381), or "12 Nov 9:00 AM" 7 or more days on, where a weekday would
// name the wrong week (#382). The app passes its own word for tomorrow.
export const formatDayTime = (value: Date | string | number, now: number, tomorrow: string) => {
  const days = indiaDay(new Date(value).getTime()) - indiaDay(now);
  const time = formatTime(value);
  if (days === 0) return time;
  if (days === 1) return `${tomorrow} ${time}`;
  return `${days < 7 ? formatWeekday(value) : formatDayMonth(value)} ${time}`;
};

export const formatDateTime = (value: Date | string | number) =>
  `${formatDate(value)}, ${formatTime(value)}`;

// "+919876543210", as `Phone` in @ygo/contracts stores it, shows as "98765 43210". Anything else shows as stored.
export const formatPhone = (value: string) => {
  const indian = /^\+91([6-9]\d{4})(\d{5})$/.exec(value);
  return indian ? `${indian[1]} ${indian[2]}` : value;
};
