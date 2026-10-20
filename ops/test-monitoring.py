import json
import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("monitoring.sh")


class MonitoringTest(unittest.TestCase):
    def test_operator_script_defines_rate_and_all_alarm_destinations(self):
        with tempfile.TemporaryDirectory() as directory:
            work = pathlib.Path(directory)
            mock = work / "aws"
            mock.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["AWS_CALLS"], "a") as calls:
    calls.write(json.dumps(args) + "\\n")
if args[:2] == ["ssm", "get-parameter"]: print("operator" + chr(64) + "example.test")
elif args[:2] == ["sns", "create-topic"]: print("test-topic")
elif args[:2] == ["logs", "describe-log-groups"]: print("None")
elif args[:2] == ["route53", "list-health-checks"]: print("None")
elif args[:2] == ["route53", "create-health-check"]: print("test-check")
''')
            mock.chmod(0o755)
            env = os.environ | {"PATH": f"{work}:{os.environ['PATH']}", "AWS_CALLS": str(work / "calls")}
            subprocess.run(["bash", str(SCRIPT), "api.example.test", "i-abcdef01", "ygo-db"],
                           env=env, check=True, capture_output=True)
            calls = [json.loads(line) for line in (work / "calls").read_text().splitlines()]
            alarms = {call[call.index("--alarm-name") + 1]: call for call in calls
                      if call[:2] == ["cloudwatch", "put-metric-alarm"]}
            self.assertEqual(len(alarms), 8)
            for alarm in alarms.values():
                self.assertIn("--alarm-actions", alarm)
                self.assertIn("--ok-actions", alarm)
            rate = alarms["ygo-5xx-rate"]
            metrics = json.loads(rate[rate.index("--metrics") + 1])
            self.assertEqual(metrics[0]["MetricStat"]["Metric"]["MetricName"], "CompletedRequests")
            self.assertEqual(metrics[1]["MetricStat"]["Metric"]["MetricName"], "ServerErrors")
            self.assertEqual(metrics[2]["Expression"], "IF(all>=20,100*errors/all,0)")
            self.assertEqual(rate[rate.index("--threshold") + 1], "5")
            self.assertIn("--insufficient-data-actions", rate)
            self.assertEqual(alarms["ygo-health"][alarms["ygo-health"].index("--region") + 1], "us-east-1")


if __name__ == "__main__":
    unittest.main()
