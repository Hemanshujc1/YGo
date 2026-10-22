import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = str(pathlib.Path(__file__).with_name("gate-lock.py"))


class GateLockTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.lock = os.path.join(self.dir.name, "gate.lock")
        self.env = dict(os.environ, YGO_GATE_LOCK=self.lock)

    def tearDown(self):
        self.dir.cleanup()

    def start(self, *command, **options):
        return subprocess.Popen([sys.executable, SCRIPT, *command], env=self.env, text=True, **options)

    def wait_until_held_by(self, process):
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                if json.loads(pathlib.Path(self.lock).read_text())["pid"] == process.pid:
                    return
            except (OSError, ValueError, KeyError):
                pass
            time.sleep(0.05)
        self.fail("the first run never took the lock")

    def test_second_run_waits_for_the_first(self):
        log = os.path.join(self.dir.name, "log")
        release = os.path.join(self.dir.name, "release")
        # The first run holds the lock until the test creates `release`.
        hold = "import os, sys, time\nwhile not os.path.exists(sys.argv[1]): time.sleep(0.02)\nopen(sys.argv[2], 'a').write('first-ended\\n')"
        first = self.start(sys.executable, "-c", hold, release, log)
        self.wait_until_held_by(first)
        second = self.start("sh", "-c", f"echo second-ran >> {log}", stderr=subprocess.PIPE)
        self.assertIn(f"Waiting for the gate already running (pid {first.pid}", second.stderr.readline())
        self.assertFalse(os.path.exists(log))
        pathlib.Path(release).touch()
        self.assertEqual(second.wait(timeout=10), 0)
        second.stderr.close()
        self.assertEqual(first.wait(timeout=10), 0)
        self.assertEqual(pathlib.Path(log).read_text().split(), ["first-ended", "second-ran"])

    def test_ctrl_c_while_waiting_exits_quietly(self):
        first = self.start("sleep", "30", start_new_session=True)
        try:
            self.wait_until_held_by(first)
            second = self.start("true", stderr=subprocess.PIPE)
            self.assertIn("Waiting", second.stderr.readline())
            second.send_signal(signal.SIGINT)
            self.assertEqual(second.wait(timeout=5), 130)
            self.assertNotIn("Traceback", second.stderr.read())
            second.stderr.close()
        finally:
            os.killpg(first.pid, signal.SIGKILL)
            first.wait()

    def test_passes_a_signal_on_to_the_command(self):
        ready = os.path.join(self.dir.name, "ready")
        command = "import sys, time\nopen(sys.argv[1], 'w').close()\ntry: time.sleep(30)\nexcept KeyboardInterrupt: sys.exit(7)"
        run = self.start(sys.executable, "-c", command, ready)
        deadline = time.time() + 5
        while not os.path.exists(ready) and time.time() < deadline:
            time.sleep(0.02)
        run.send_signal(signal.SIGINT)
        self.assertEqual(run.wait(timeout=5), 7)

    def test_a_killed_holder_frees_the_lock(self):
        first = self.start("sleep", "30", start_new_session=True)
        try:
            self.wait_until_held_by(first)
            os.kill(first.pid, signal.SIGKILL)
            first.wait(timeout=5)
            # Its `sleep` child is still running, yet the next run goes ahead.
            self.assertEqual(self.start("true").wait(timeout=5), 0)
        finally:
            os.killpg(first.pid, signal.SIGKILL)

    def test_passes_the_command_exit_code(self):
        self.assertEqual(self.start("sh", "-c", "exit 3").wait(timeout=5), 3)


if __name__ == "__main__":
    unittest.main()
