import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/env.ts"],
    testTimeout: 15_000,
    // One shared database: run files serially.
    fileParallelism: false,
    // next-auth imports "next/server" without an extension, which Node ESM rejects.
    server: { deps: { inline: ["next-auth"] } },
  },
});
