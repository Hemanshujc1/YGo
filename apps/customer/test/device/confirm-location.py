"""Native regression for #387; run against a signed-in Android development app.

The API, Customer Metro and Google maps/geocoding must be available. This saves
an Other address near Mumbai airport. Example (adb must be on PATH):
  ANDROID_SERIAL=<device> python3 apps/customer/test/device/confirm-location.py
Add --search to repeat Change location -> airport search -> Confirm, including
Back from the map to search and reopening it. Native parenting cannot be tested
by the Vitest map mock.
"""

import argparse
import re
import shlex
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--package", default="dev.local.ygocustomer")
parser.add_argument("--search", action="store_true")
args = parser.parse_args()


def adb(*command):
    return subprocess.run(
        ["adb", *command], check=True, capture_output=True, timeout=25
    ).stdout.decode(errors="replace")


def screen():
    adb("shell", "uiautomator dump /sdcard/ygo-confirm-test.xml >/dev/null")
    nodes = list(ET.fromstring(adb("exec-out", "cat", "/sdcard/ygo-confirm-test.xml")).iter("node"))
    text = "\n".join(n.get("text", "") + " " + n.get("content-desc", "") for n in nodes)
    if "addViewAt" in text or "specified child already has a parent" in text:
        raise AssertionError("Confirm location triggers addViewAt: child already has a parent")
    return nodes


def wait_for(predicate, before_text=None):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        nodes = screen()
        if before_text is not None:
            end = next((i for i, n in enumerate(nodes) if n.get("text") == before_text), len(nodes))
            nodes = nodes[:end]
        found = next((n for n in nodes if predicate(n)), None)
        if found is not None:
            return found
        time.sleep(0.5)
    raise AssertionError("Expected screen/control did not appear")


def tap(node):
    left, top, right, bottom = map(int, re.findall(r"\d+", node.get("bounds")))
    assert right > left and bottom > top, "Control is outside the screen"
    adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))


def button(label):
    return wait_for(lambda n: n.get("content-desc") == label and n.get("clickable") == "true" and n.get("enabled") == "true")


adb("shell", "am", "force-stop", args.package)
route = "" if args.search else "confirm-location?latitude=19.096703261799934&longitude=72.88060951977968"
adb("shell", "am start -W -a android.intent.action.VIEW -d " + shlex.quote("ygo-customer://" + route) + " -n " + shlex.quote(args.package + "/.MainActivity"))

if args.search:
    tap(wait_for(lambda n: n.get("clickable") == "true" and "Change location" in n.get("content-desc", "")))
    field = wait_for(lambda n: n.get("class", "").endswith("EditText") and n.get("content-desc") == "Search area, street or pincode")
    tap(field)
    adb("shell", "input", "text", "Mumbai%sairport")
    adb("shell", "input", "keyevent", "4")
    tap(button("Search"))
    airport = lambda n: "airport" in (n.get("text", "") + n.get("content-desc", "")).lower() and not n.get("class", "").endswith("EditText")
    tap(wait_for(airport, before_text="Saved addresses"))
    wait_for(lambda n: n.get("content-desc") == "Google Map")
    tap(button("Back"))
    tap(wait_for(airport, before_text="Saved addresses"))

field = wait_for(lambda n: n.get("class", "").endswith("EditText") and n.get("content-desc") == "Flat, house or floor")
tap(field)
adb("shell", "input", "text", "Map%sregression")
adb("shell", "input", "keyevent", "4")
width, height = map(int, re.findall(r"\d+", adb("shell", "wm", "size"))[-2:])
adb("shell", "input", "swipe", str(width // 2), str(height * 83 // 100), str(width // 2), str(height * 59 // 100), "350")
tap(button("Other"))
tap(button("Confirm location"))
wait_for(lambda n: "No shop delivers here yet" in n.get("text", "") or n.get("text") == "Not serviceable yet")
screen()
print("PASS: airport confirmation reaches the outside-radius destination without the native view error")
