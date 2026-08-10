import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setup.ts"],
    // Every test file shares one real Postgres test database and truncates it
    // in beforeEach — running files in parallel would let one file's truncate
    // wipe another file's in-flight data.
    fileParallelism: false,
  },
});
