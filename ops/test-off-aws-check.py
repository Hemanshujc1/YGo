import datetime as dt
import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).with_name("off-aws-check.py")
spec = importlib.util.spec_from_file_location("off_aws_check", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NOW = dt.datetime(2026, 10, 20, 12, tzinfo=dt.timezone.utc)
REAL_DATETIME = dt.datetime


class OffAwsCheckTest(unittest.TestCase):
    def test_age_boundary_and_bad_dates(self):
        for value, expected in [
            ("2026-09-20T12:00:00Z", True),
            ("2026-09-20T11:59:59Z", False),
            ("2026-10-20T12:00:01Z", False),
            ("2026-02-30T00:00:00Z", False),
            ("", False),
            ("None", False),
        ]:
            with self.subTest(value=value):
                self.assertEqual(module.healthy(value, NOW), expected)

    @patch.object(module.dt, "datetime")
    @patch.object(module.subprocess, "run")
    def test_failed_read_publishes_unhealthy(self, command, datetime):
        datetime.now.return_value = NOW
        command.side_effect = [subprocess.CalledProcessError(1, "aws"), subprocess.CompletedProcess([], 0)]
        self.assertEqual(module.run(), 1)
        self.assertIn("0", command.call_args.args[0])

    @patch.object(module.dt, "datetime")
    @patch.object(module.subprocess, "run")
    def test_invalid_or_future_date_publishes_unhealthy(self, command, datetime):
        datetime.now.return_value = NOW
        datetime.strptime.side_effect = REAL_DATETIME.strptime
        for value in ["2026-02-30T00:00:00Z", "2026-10-20T12:00:01Z", "None"]:
            with self.subTest(value=value):
                command.side_effect = [subprocess.CompletedProcess([], 0, value), subprocess.CompletedProcess([], 0)]
                self.assertEqual(module.run(), 1)
                self.assertIn("0", command.call_args.args[0])

    @patch.object(module.subprocess, "run", side_effect=OSError("offline"))
    def test_failed_publish_is_nonzero(self, command):
        self.assertEqual(module.run(), 1)
        self.assertEqual(command.call_count, 2)


if __name__ == "__main__":
    unittest.main()
