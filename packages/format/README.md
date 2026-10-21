# @ygo/format

How every client displays money, numbers, dates, times and phone numbers (ADR-0007, `Q-4` in the PRD).

| Item | Format |
| --- | --- |
| Money | ₹1,25,000.00: Indian digit grouping, two decimals on every amount |
| Date | 13/10/2026 |
| Time | 2:05 PM, 12-hour |
| Date and time | 13/10/2026, 2:05 PM |
| Phone | 98765 43210 |

Everything is stored in UTC and displayed in Asia/Kolkata only. The full list is in section 3 of `docs/design/design-system.md`.

Use `formatNumber`, `formatMoney`, `formatDate`, `formatTime`, `formatDateTime` and `formatPhone` rather than constructing an `Intl` formatter in an app. Dates accept a `Date`, an ISO string or a UTC epoch value. Money formatting is display only; it does no arithmetic. `formatPhone` takes a number as `Phone` in `@ygo/contracts` stores it (`+919876543210`); any other value shows unchanged.

The server imports this package, so it stays runtime-agnostic: no UI or React dependency (ADR-0007).
