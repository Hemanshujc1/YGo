import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The gate also runs both Expo exports. Parallel database migrations
    // compete with those builds and exceed test/hook deadlines (#301). Keep
    // files isolated and concurrency inside each test, but run one file at a time.
    maxWorkers: 1,
    // Under the whole workspace's load (`pnpm check`) every test runs up to 5 times
    // slower than alone, so a test that takes 1.5 to 2.5 s alone crosses the 5 s
    // default (#576). Setup is not the cause: it takes under 1.2 s even then.
    testTimeout: 30_000,
    globalSetup: ["test/global-setup.ts"],
  },
});
