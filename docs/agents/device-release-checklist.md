# Device release checklist

Run this by hand before every Customer or Shopkeeper app release. Use an entry-level Android 10 phone with 2 GB RAM and an iPhone running iOS 16.4 or later. Use release builds, in portrait, against the release candidate server. Record the device model, OS, app versions and results in a copy of the run record below. A simulator does not replace either phone.

Before a store release, set both `EXPO_PUBLIC_ANDROID_STORE_URL` and `EXPO_PUBLIC_IOS_STORE_URL` for that build.

Test each available screen and flow in both light and dark themes on both phones. Check its normal path, loading, empty and error states where available: text is readable, content scrolls without clipping, controls are reachable with a thumb, touch targets are at least 48 dp, and the next action works. Bills and receipts stay light in both themes. See [Q-1, Q-3 and Q-5](../product/prd-phase1.md#6-qualities-the-product-must-have) and the [screen inventory](../product/specs-ui-phase1.md#screen-inventory).

## Keep this list current

Every ticket that adds a mobile screen or flow adds a row below in the same PR, with its screen id if one exists, the action to perform and the expected result. Add a separate row for a new hardware or sharing path. A changed path updates its row. Before each release, compare the rows with the app routes and the shipped screen ids in the [Specs UI](../product/specs-ui-phase1.md); add any missing rows before testing. Mark an unbuilt check `N/B`, and a check that does not apply to an app or device `N/A`; neither is a pass. Until theme choice ships in #120 and #124, mark unavailable theme cells `N/B`. A shipped check must pass on both phones before release, or its failure and release decision must be recorded.

## Checks

Run every applicable row in both themes. The screen rows cover what is available in this branch; the capability rows below them stay on the list so they cannot be missed when their tickets ship.

| ID | App | Action and expected result | Available when |
| --- | --- | --- | --- |
| C-health | Customer | Open the app with the server reachable: the server health answer appears. Repeat with the server unreachable: the screen explains that it cannot connect. | Now |
| S-health | Shopkeeper | Open the app with the server reachable: the server health answer appears. Repeat with the server unreachable: the screen explains that it cannot connect. | Now |
| Update | Customer and Shopkeeper | Raise the app's minimum version on the release candidate server above the build's version. Confirm the update-required screen appears and its Update button opens the app's store listing, in both themes. | Now |
| Alarm | Shopkeeper | With the app open, backgrounded and phone locked, send a new order. Confirm a loud in-app alarm when open, a notification with a one-tap order target when backgrounded, and the platform fallback where a full-screen alert is unavailable. Check the repeat alert and permission-limited state. Record what actually happened on each phone. | #55 and #57 |
| Camera | Shopkeeper | Take a delivery proof photo, review it and save it; confirm the photo remains available offline. Deny camera permission and confirm the screen gives a way to recover. | #56 and #68 |
| Barcode | Shopkeeper | Scan a stocked barcode from the bill and stock paths; confirm the correct product appears. Try an unknown barcode and denied camera permission; confirm each result is clear. Repeat offline. | #53 and #67 |
| Bill PDF | Shopkeeper | Make a real counter bill and share its PDF to another app. Open the shared file: the bill is readable, ₹ and money columns render correctly, and it stays light in dark theme. Before sync it shows the permanent reference and “Number pending”; after sync it shows the reference and bill number. | #51 and #53 |

The alarm's iPhone notification fallback and Android permission limits are specified in [ADR-0001](../adr/0001-mobile-app-framework.md); judge each device against that behaviour rather than expecting the same full-screen alert on both.

## Run record

Copy this section for each release and keep the completed record with the release notes. Use `P` (pass), `F` (fail), `N/B` (not built) or `N/A` (not applicable) in each result cell. For a failure, put the issue link or a short description in the last column.

Release/version and date: __________  Tester: __________  Server/environment: __________

Android model / RAM / OS / app build: __________  iPhone model / iOS / app build: __________

| ID | Android light | Android dark | iPhone light | iPhone dark | Issue / observation |
| --- | --- | --- | --- | --- | --- |
| C-health | | | | | |
| S-health | | | | | |
| Update | | | | | |
| Alarm | | | | | |
| Camera | | | | | |
| Barcode | | | | | |
| Bill PDF | | | | | |

Add one result row for every new check row above. Record failures with an issue link, retest result and the release decision here: __________
