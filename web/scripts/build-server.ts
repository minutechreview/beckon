// Compiles the custom server and the migration runner to plain JavaScript, so production does not run
// through tsx. Dependencies stay external (they come from node_modules in the image); only the
// project's own TypeScript is bundled, with its "@/..." paths resolved from tsconfig.json.
import { build } from "esbuild";

await build({
  entryPoints: { server: "server.ts", migrate: "scripts/migrate.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
  // Top-level await and dynamic imports of the project's own modules are kept as written.
  splitting: false,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
