import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Invented test values only.
          bindings: { TEST_MIGRATIONS: migrations, ADMIN_PASSWORD: "test-admin-password-123" },
        },
      }),
    ],
    // Only this checkout's tests: copies in other worktrees under .claude/worktrees are not ours to run.
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
