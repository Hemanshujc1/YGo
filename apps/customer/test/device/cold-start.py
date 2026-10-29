"""Native #402 regression; requires signed-in Customer, API, maps and Metro.

Force-stop and deep-link into Confirm location, probing native UI during startup.
Run the same command on unpatched and patched APKs; preserve the failure log.
An alive process alone does not count: the native map must have rendered too.
"""

import argparse
import re
import shlex
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--package", default="dev.local.ygocustomer")
parser.add_argument("--launches", type=int, default=20)
parser.add_argument("--crash-log", type=Path, default=Path("/tmp/ygo-cold-start-crash.log"))
args = parser.parse_args()
if args.launches < 1:
    parser.error("--launches must be positive")

# ANDROID_SERIAL selects the device, as in the airport regression.
adb = ["adb"]
route = "ygo-customer://confirm-location?latitude=19.096703261799934&longitude=72.88060951977968"
for attempt in range(1, args.launches + 1):
    subprocess.run([*adb, "shell", "am", "force-stop", args.package], check=True, capture_output=True, timeout=30)
    launch = subprocess.run(
        [*adb, "shell", "am start -W -a android.intent.action.VIEW -d " + shlex.quote(route) + " -n " + shlex.quote(args.package + "/.MainActivity")],
        check=True, capture_output=True, text=True, timeout=30,
    )
    if "Error" in launch.stdout + launch.stderr:
        raise AssertionError(launch.stdout + launch.stderr)
    initial = subprocess.run([*adb, "shell", "pidof", args.package], capture_output=True, text=True, timeout=10)
    pid = initial.stdout.strip()
    print(f"Launch {attempt}: PID {pid or 'absent'}", flush=True)
    started = time.monotonic()
    deadline = started + 60
    map_rendered = False
    while time.monotonic() < deadline:
        subprocess.run([*adb, "shell", "uiautomator dump /sdcard/ygo-cold-start.xml >/dev/null"], check=True, capture_output=True, timeout=30)
        probe = subprocess.run([*adb, "shell", "pidof", args.package], capture_output=True, text=True, timeout=10)
        if not pid or probe.stdout.strip() != pid:
            crash = subprocess.run([*adb, "logcat", "-b", "crash", "-d", "-v", "brief"], check=True, capture_output=True, text=True, timeout=30).stdout
            # Match this process, not an old crash left in the ring buffer.
            marker = re.search(r"pid: " + re.escape(pid) + r",.*>>> " + re.escape(args.package) + r" <<<", crash) if pid else None
            trace = crash[marker.start():] if marker else crash
            args.crash_log.write_text(trace)
            signature = "MountingCoordinator::pullTransaction" in trace and "signal 11" in trace and marker is not None
            reason = "SIGSEGV in MountingCoordinator::pullTransaction" if signature else "process exited/restarted (inspect crash log)"
            raise AssertionError(f"Launch {attempt}: {reason}; {args.crash_log}")
        ui = subprocess.run([*adb, "exec-out", "cat", "/sdcard/ygo-cold-start.xml"], check=True, capture_output=True, text=True, timeout=10).stdout
        map_rendered |= 'content-desc="Google Map"' in ui and args.package in ui
        if map_rendered and time.monotonic() - started >= 15:
            break
        time.sleep(0.5)
    if not map_rendered:
        raise AssertionError(f"Launch {attempt}: process survived but native map did not render")
    print(f"Launch {attempt}: alive for at least 15 seconds; native map rendered", flush=True)
print(f"PASS: {args.launches} cold launches without process death", flush=True)
