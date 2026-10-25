import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The gate also runs both Expo exports. Parallel database migrations
    // compete with those builds and exceed test/hook deadlines (#301). Keep
    // files isolated and concurrency inside each test, but run one file at a time.
    maxWorkers: 1,
    globalSetup: ["test/global-setup.ts"],
  },
});
