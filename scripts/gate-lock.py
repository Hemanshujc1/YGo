#!/usr/bin/env python3
"""Run a command while holding this clone's gate lock (docs/agents/workflow.md).

Every worktree of one clone shares its git common directory, so a lock file
there lets only one `pnpm gate` run at a time on the machine. The kernel drops
an flock when its holder dies, so a crashed or killed run never leaves the
lock stuck. The lock's file descriptor is not inherited, so a background
process the command leaves behind (such as turbo's daemon) cannot hold it.
"""

import fcntl
import json
import os
import signal
import subprocess
import sys
import time


def lock_path():
    if os.environ.get("YGO_GATE_LOCK"):
        return os.environ["YGO_GATE_LOCK"]
    common = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return os.path.join(common, "ygo-gate.lock")


def acquire(path):
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
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
    info = {"pid": os.getpid(), "cwd": os.getcwd(), "started": time.strftime("%H:%M:%S")}
    os.ftruncate(fd, 0)
    os.pwrite(fd, json.dumps(info).encode(), 0)
    return fd


def main(argv):
    if not argv:
        sys.exit("usage: gate-lock.py <command> [args…]")
    fd = acquire(lock_path())
    child = subprocess.Popen(argv)
    # Ctrl-C reaches the child from the terminal; wait for it to finish.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda number, _frame: child.send_signal(number))
    code = child.wait()
    os.close(fd)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
