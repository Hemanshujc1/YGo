#!/usr/bin/env python3
"""Run a command while holding this clone's gate lock (docs/agents/workflow.md).

Every worktree of one clone shares its git common directory, so a lock file
there lets only one `pnpm gate` run at a time on the machine. The kernel drops
an flock when its holder dies, so a crashed or killed run never leaves the
lock stuck. The lock's file descriptor is not inherited, so a background
process the command leaves behind cannot hold it; the price is that killing
this wrapper with SIGKILL frees the lock while its command still runs.
"""

import fcntl
import json
import os
import signal
import subprocess
import sys
import time


def main(argv):
    if not argv:
        sys.exit("usage: gate-lock.py <command> [args…]")
    child = None

    def forward(number, _frame):
        if child is None:
            sys.exit(128 + number)
        child.send_signal(number)

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, forward)

    path = os.environ.get("YGO_GATE_LOCK")
    if not path:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        path = os.path.join(common, "ygo-gate.lock")
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    except OSError as error:
        print(f"Running without the gate lock: cannot open {path} ({error.strerror}).", file=sys.stderr)
        fd = None
    if fd is not None:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            try:
                holder = json.loads(os.pread(fd, 4096, 0) or b"{}")
                who = f" (pid {holder['pid']} in {holder['cwd']}, started {holder['started']})"
            except (ValueError, KeyError):
                who = ""
            print(f"Waiting for the gate already running{who}…", file=sys.stderr, flush=True)
            fcntl.flock(fd, fcntl.LOCK_EX)
        os.ftruncate(fd, 0)
        os.pwrite(fd, json.dumps({"pid": os.getpid(), "cwd": os.getcwd(), "started": time.strftime("%H:%M:%S")}).encode(), 0)

    child = subprocess.Popen(argv)
    code = child.wait()
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
