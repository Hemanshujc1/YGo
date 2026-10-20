import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JobName } from "../jobs";

const execFileAsync = promisify(execFile);

export async function publishJobHealth(name: JobName, healthy: boolean): Promise<void> {
  await execFileAsync("aws", [
    "cloudwatch", "put-metric-data", "--region", "ap-south-1",
    "--namespace", "YGo", "--metric-name", "JobHealthy",
    "--dimensions", `JobName=${name}`,
    "--value", healthy ? "1" : "0", "--unit", "Count",
  ]);
}
