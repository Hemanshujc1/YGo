# @ygo/format

How every client displays money, numbers, dates and times (ADR-0007, `Q-4` in the PRD). Empty until the first screen needs one of these.

| Item | Format |
| --- | --- |
| Money | ₹1,25,000.00: Indian digit grouping, two decimals on every amount |
| Date | 13/10/2026 |
| Time | 2:05 PM, 12-hour |
| Date and time | 13/10/2026, 2:05 PM |

Everything is stored in UTC and displayed in Asia/Kolkata only. The full list is in section 3 of `docs/design/design-system.md`.

The server imports this package, so it stays runtime-agnostic: no UI or React dependency (ADR-0007).
