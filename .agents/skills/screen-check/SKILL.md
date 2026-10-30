---
name: screen-check
description: Get a YGo screen ready for the owner to check, or help fix a failed screen-check line. Use when the owner asks to test, check, run or debug a screen, a "Screen check" batch or line, or a screen-test issue. Starts the database, mail inbox, server, Metro or Admin web and the phone build (OPPO or iOS Simulator), then gives exact tap-by-tap steps. Ticks the lines the owner passes on GitHub and closes the batch when none is left open.
---

# Screen check

The owner checks screens by hand (`docs/agents/workflow.md`, section 7): phone screens on the OPPO or the iOS Simulator, Admin on a browser. This skill does the setup the owner would otherwise do, then hands over a short list of steps. Run the setup yourself; ask the owner only for what needs their hands (plugging in or unlocking the phone, a Google sign-in).

Project docs win over this skill. The run commands live in `apps/server/README.md`, `apps/customer/README.md`, `apps/shopkeeper/README.md` and `apps/admin/README.md`; if one changed, follow it and fix this file in the same PR.

## 1. Find what to check

- A batch or line given (`#409`, "batch 8"): `gh issue view <n>`. Take the unticked lines.
- A failed line with a fix issue: read the issue and the line it links.
- A PR or branch given: read its "Screen check" section.
- Nothing given: ask which screen.

Decide the target for each phone line: the OPPO (Android), the iOS Simulator, or both. A line or batch that names iOS, Apple sign-in, the iOS map, safe areas or a notch, or any iOS-only behaviour gets the simulator; a line that says nothing runs on the OPPO only. When the owner says "iOS", "simulator" or "both", follow that. Ask only if a line could go either way and the owner has not said.

For each line note the app (Customer, Shopkeeper, Admin web, public web), the screen, the account type it needs (customer, shop Owner, Admin, Area Manager) and the data it needs (a Live shop, products, an address, a cart, a holiday).

Check the code is the code to test: `git branch --show-current` and `git status --short`. Batches run from the latest `main` (`git pull --ff-only` in the main folder). A fix PR runs from its own worktree (`git worktree list`). A worktree has no `.env` files (git-ignored): copy `apps/server/.env`, `apps/customer/.env` and `apps/shopkeeper/.env` from the main folder, never print their contents.

Done when you hold the list of lines, which apps they touch, and the folder to run from.

## 2. Start the backend

Run each only if it is not already up. Long-running ones go in the background.

1. **Docker.** `docker info >/dev/null 2>&1` fails when it is stopped: `open -a Docker` (or `open -a OrbStack`) and poll `docker info` until it answers.
2. **Database.** `docker start ygo-postgres`; when the container does not exist, create it with the command in `apps/server/README.md` step 1. Wait until `docker exec ygo-postgres pg_isready -U ygo` says accepting.
3. **Mail inbox.** `docker start ygo-mailpit`, or create it as in step 2 of the README. Sign-in codes land at http://localhost:8025.
4. **Product images**, only when a line uses product photos or Admin image upload: `docker start ygo-s3`, or create it as in "Local product images", and make sure `apps/server/.env` has the five S3 lines.
5. **Migrations.** From the folder under test: `pnpm --filter @ygo/server build`, then `set -a; . apps/server/.env; set +a; node apps/server/dist/migrate.js`. Run it every time: a branch may carry new migrations. Never drop or reset the owner's `ygo` database; a clean database needs the owner's say-so.
6. **Server.** A phone reaches the Mac over wifi, so the server must listen on all interfaces: `HOST=0.0.0.0 pnpm --filter @ygo/server dev` in the background. Only the server for the folder under test may run: `lsof -i :3000` shows an old one from another worktree; stop that one first. Check `curl -s http://127.0.0.1:3000/v1/healthz` prints `{"status":"ok"}`.
7. **Lower-than-minimum versions.** If a line needs the update-required screen, set `MIN_CUSTOMER_VERSION` or `MIN_SHOPKEEPER_VERSION` above the app's version in `apps/server/.env` and restart the server; set it back afterwards.

Done when healthz answers `ok`, Mailpit answers on 8025, and `docker ps` shows the containers the lines need.

## 3. Prepare the account and the data

There is no seed script. Make the data the lines need by the app's own screens or the server's routes, and say in the steps what you made.

- **Customer or shopkeeper sign-in.** Sign-in is an email code: the app sends it, read it from Mailpit (`curl -s http://localhost:8025/api/v1/messages | head -c 1500`, newest first). Tell the owner to use an email like `owner1@example.com`; Mailpit catches everything.
- **Admin.** If the `admins` table is empty, run the bootstrap in `apps/server/README.md` ("First Admin") with an `@example.com` email, and tell the owner the email. Admin web sign-in is also an email code in Mailpit.
- **A Live shop** (most Customer lines need one): apply as a shopkeeper (S17), then as Admin approve it, set rate cards, sign the agreement and Move to Live. If a Live shop already exists in the database, reuse it (query with `docker exec ygo-postgres psql -U ygo -d ygo -c "select id, name, status from shops"`). Read the table and column names from `apps/server/src/schema.ts`; do not guess them.
- Insert rows by SQL only when the screens cannot make them in reasonable time, and never touch rows you did not make.

Done when every account and record a line needs exists, and you can name each one (email, shop name, address).

## 4. Start the app under test

**Admin web / public web.** `pnpm --filter @ygo/admin dev` (or `@ygo/web`) in the background; read the URL it prints (Vite, usually http://localhost:5173). Admin proxies `/v1` to the server on 3000.

**Phone apps.** Whichever target, start with the address: `ipconfig getifaddr en0` is the Mac's LAN address. `EXPO_PUBLIC_API_BASE_URL` in the app's `.env` must be `http://<that address>:3000`; it works from the OPPO and from the iOS Simulator alike, so one value serves both. If it differs (the owner's wifi changed), update the `.env` line; the change needs Metro restarted with `--clear`, and a rebuild is not needed.

**On the OPPO (Android):**

- `adb devices` should list the OPPO as `device`. Empty list: ask the owner to plug it in, unlock it and accept the USB debugging prompt. `unauthorized`: the same prompt. Skip the Android emulator when the owner tests on the OPPO; if they ask for one, `emulator -list-avds`, start it, and use `http://10.0.2.2:3000` in `.env`.
- Is the dev build installed? `adb shell pm list packages | grep ygo`: Customer is `dev.local.ygocustomer`, Shopkeeper is `dev.local.ygoshopkeeper`. If it is missing, or the branch changed native modules, `app.config.ts`, `app.json` plugins or a map key, build and install: `pnpm --filter @ygo/customer android` (or `shopkeeper`). That also starts Metro. A JavaScript-only change needs no rebuild.

- **"Unable to load script" on the OPPO.** The debug APKs have no dev launcher, so the app asks for Metro at `localhost:8081`, which the phone cannot reach. Point it at the Mac: write an XML file holding `debug_http_host` = `<mac LAN ip>:8081` as the app's `shared_prefs/<package>_preferences.xml`. Do it with `adb push` to `/data/local/tmp/` and then `adb shell run-as <package> cp /data/local/tmp/<file> shared_prefs/<package>_preferences.xml` (a `run-as sh -c '...'` one-liner breaks on quoting). Force-stop and reopen the app. Redo it after the app data is cleared or the phone's wifi address changes.
- **Native crash right after a rebuild** (SIGSEGV in `MountingCoordinator::pullTransaction`, or any crash after a change to `patches/` or a native dependency). Gradle may reuse an old `librnscreens.so`. Clear the cache and rebuild: `rm -rf apps/<app>/android/app/.cxx apps/<app>/android/app/build`, then `pnpm --filter @ygo/<app> android`, then check the `.so` under `app/build` has today's date. Do this for each phone app before its first test after such a change.
- **First launch after `expo start --clear` hangs on the splash.** Metro is building the whole bundle cold. Warm it once with `curl -s -o /dev/null "http://127.0.0.1:8081/apps/<app>/node_modules/expo-router/entry.bundle?platform=android&dev=true&hot=false&lazy=true&transform.engine=hermes&transform.bytecode=1&transform.routerRoot=src%2Fapp&unstable_transformProfile=hermes-stable"` (a minute or two), then reopen the app.

**On the iOS Simulator:**

- Needs Xcode (`xcode-select -p`). List simulators with `xcrun simctl list devices available`; use the one already there (`YGo Batch 1`, iOS 26.5) or a booted one. Boot it: `xcrun simctl boot "<name>"; open -a Simulator`, then wait for `xcrun simctl list devices booted` to show it.
- Is the dev build installed? `xcrun simctl listapps booted | grep -i ygo` (bundle IDs `dev.local.ygocustomer` and `dev.local.ygoshopkeeper`). If it is missing, or native code or config changed, build and install: `pnpm --filter @ygo/customer ios` (or `shopkeeper`). That compiles with Xcode, which takes minutes the first time, and also starts Metro; run it in the background and watch for "Build Succeeded". `ios/` is git-ignored, so a fresh worktree has none: the first `expo run:ios` there generates it.
- Otherwise start Metro and launch the app: `xcrun simctl launch booted dev.local.ygocustomer`.
- Simulator limits to say out loud: GPS is fake, so set a place with `xcrun simctl location booted set <lat>,<lng>` (Mumbai airport is `19.0896,72.8656`) or Simulator's Features > Location; there is no camera, so photo lines need a library photo (drag an image onto the Simulator window); push notifications and real Apple sign-in need a device or a signed-in Apple ID in the Simulator's Settings. Say which lines the Simulator cannot prove and leave those to the OPPO or another device.
- A screenshot: `xcrun simctl io booted screenshot <scratchpad>/shot.png`. The app's logs: `xcrun simctl spawn booted log stream --predicate 'process == "YGo"' --level error`.

Port 8081 serves one app at a time; to test Customer and Shopkeeper together run the second on `--port 8082`. When testing on both targets, one Metro serves both.

Port 8081 is also taken by an old Metro from another worktree: `lsof -i :8081`, stop it before starting yours.

Done when the app is open on each target at its first screen (or Admin web loads in the browser), and it reaches the server (no "Can't reach YGo").

## 5. Give the owner the steps

Write them for someone holding the phone. Use this shape for each line, in the order of the batch:

```
Line N: <app>, <screen>  (#<PR>)
Device: <OPPO / iOS Simulator>
Sign in as: <email>  (code arrives at http://localhost:8025)
Set up already: <the shop, address, products you made>
Do:
  1. <tap / type, naming the exact button text from the app's strings>
  2. ...
Expect: <what appears, in the words on screen>
Also try: <the edge the PR names: empty state, offline, a closed shop>
Fails if: <the symptom that means the line failed>
```

Take the "what to tap / expect" from the batch line and the PR body; read the screen's code (`apps/<app>/src/app/...`) and `src/strings.ts` for the real button and heading text rather than paraphrasing. Write amounts and percentages as the app shows them under the no-trailing-zero rule in `AGENTS.md` ("₹60", "₹59.50", "10%", "7.69% off"), whatever an older line or PR says. Add what the line leaves out and a tester needs: the account, the data, and a negative case (wrong code, no network, no permission).

After the steps, tell the owner in two or three lines: what is running (server, Metro, containers), the URLs, and how to look at logs (server and Metro output, `adb logcat *:E`, or the Simulator log command above).

## 6. When the owner reports a failure

1. Capture evidence before changing anything: the server log lines, Metro's red screen text, `adb logcat -d *:E | tail -50`, a screenshot (`adb exec-out screencap -p > <scratchpad>/shot.png` on Android, `xcrun simctl io booted screenshot <scratchpad>/shot.png` on the Simulator).
2. Say whether it is the app, the server, or the setup (wrong data, stale build, wrong wifi address). Setup problems you fix at once.
3. An app or server bug becomes a fix issue linked on that line (`docs/agents/workflow.md`, section 7); use `mattpocock-skills:diagnosing-bugs` to find the cause. The fix PR carries its own "Screen check" line.

## 7. Record the results on GitHub

The owner's word decides each line; you write it down. Tick a line only when the owner says it passed, never on your own test or a screenshot.

1. **A line passed.** Read the batch body (`gh issue view <batch> --json body --jq .body`), turn that line's `- [ ]` into `- [x]`, and save it with `gh issue edit <batch> --body-file <scratchpad>/batch.md`. Find the line by its `(#<PR>)` ending and change only that line.
2. **A line failed.** Leave it unticked and add ` → fix #<issue>` at its end, once the fix issue from step 6 exists.
3. **Every line is ticked or links a fix issue.** Close the batch: `gh issue close <batch> --comment "All lines checked: <n> passed, fixes in #a, #b."` (or "all passed").

Done when the batch on GitHub shows what the owner reported, and it is closed if no line is left open.

## 8. Clean up

When the owner is done, or says stop: stop the background Metro, Vite and server you started. Shut down a Simulator you booted only if the owner asks. Leave the Docker containers running unless asked; they hold the owner's data. Put back any `.env` value you changed for a line (`MIN_*_VERSION`).
