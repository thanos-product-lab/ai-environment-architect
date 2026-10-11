import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "schemas/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/fixtures/**"],
    setupFiles: ["test/support/fast-check-seed.ts"],
  },
});
