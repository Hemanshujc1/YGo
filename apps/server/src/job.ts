import { loadDatabaseUrl, loadDeliveryPhotoSettings, loadOrderTiming } from "./config";
import { connectDatabase, type Database } from "./db";
import { setOrderTiming } from "./order-timing";
import { isJobName, runJob } from "./jobs";
import { runNightlyBackup, runWeeklySnapshot } from "./adapters/backup";
import { createDeliveryPhotoStorage } from "./adapters/delivery-photos";
import { createS3FileStorage } from "./adapters/file-storage";

const name = process.argv[2];
if (!name || !isJobName(name) || process.argv.length !== 3) {
  console.error("Unknown job name");
  process.exitCode = 1;
} else {
  let database: Database | undefined;
  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
    setOrderTiming(loadOrderTiming());
    database = connectDatabase(loadDatabaseUrl());
    // Only the session cleanup deletes delivery photos; the other jobs need none of these settings.
    const photoSettings = name === "cleanup-sessions" ? loadDeliveryPhotoSettings() : undefined;
    const deliveryPhotos = photoSettings?.VISIT_PHOTO_BUCKET ? createDeliveryPhotoStorage(createS3FileStorage({
      bucket: photoSettings.VISIT_PHOTO_BUCKET, region: photoSettings.S3_REGION, endpoint: photoSettings.S3_ENDPOINT,
    })) : undefined;
    await runJob(database, name, { now: () => new Date() }, runNightlyBackup, runWeeklySnapshot, deliveryPhotos);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const databaseUrl = process.env.DATABASE_URL;
    console.error(`${name} failed: ${databaseUrl ? message.replaceAll(databaseUrl, "[redacted]") : message}`);
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}
