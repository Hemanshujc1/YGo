import { spawn } from "node:child_process";

export async function runNightlyBackup(): Promise<void> {
  const bucket = process.env.BACKUP_BUCKET;
  if (!bucket) throw new Error("BACKUP_BUCKET is missing");
  await runBackup("dump", bucket);
}

export async function runWeeklySnapshot(): Promise<void> {
  const instance = process.env.RDS_INSTANCE_ID;
  if (!instance) throw new Error("RDS_INSTANCE_ID is missing");
  await runBackup("snapshot", instance);
}

async function runBackup(mode: "dump" | "snapshot", target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/bash", ["/opt/ygo/ops/backup.sh", mode, target], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${mode} command failed`)));
  });
}
