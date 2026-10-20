import { spawn } from "node:child_process";

export async function runNightlyBackup(): Promise<void> {
  const bucket = process.env.BACKUP_BUCKET;
  if (!bucket) throw new Error("BACKUP_BUCKET is missing");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/bash", ["/opt/ygo/ops/backup.sh", "dump", bucket], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Backup command failed")));
  });
}
