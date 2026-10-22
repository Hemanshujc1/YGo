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
        note = "import sys, time; time.sleep(float(sys.argv[2])); open(sys.argv[1], 'a').write(sys.argv[3] + ' %f\\n' % time.time())"
        first = self.start(sys.executable, "-c", note, log, "1", "first-ended")
        self.wait_until_held_by(first)
        second = self.start(sys.executable, "-c", note, log, "0", "second-ran", stderr=subprocess.PIPE)
        _, waiting = second.communicate(timeout=10)
        self.assertEqual(first.wait(timeout=10), 0)
        lines = dict(line.split() for line in pathlib.Path(log).read_text().splitlines())
        self.assertGreaterEqual(float(lines["second-ran"]), float(lines["first-ended"]))
        self.assertIn(f"Waiting for the gate already running (pid {first.pid}", waiting)

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
