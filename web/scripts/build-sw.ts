// Bundles src/sw/sw.ts (with the M3 crypto code) into public/sw.js.
// Run by `npm run build`, and by the dev server at startup.
import path from "node:path";
import { build } from "esbuild";

export async function buildServiceWorker(opts: { production?: boolean } = {}) {
  const root = path.resolve(import.meta.dirname, "..");
  await build({
    entryPoints: [path.join(root, "src/sw/sw.ts")],
    outfile: path.join(root, "public/sw.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: opts.production ?? process.env.NODE_ENV === "production",
    sourcemap: false,
    alias: { "@": path.join(root, "src") },
    define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development") },
    logLevel: "warning",
    legalComments: "none",
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildServiceWorker({ production: true });
  console.log("built public/sw.js");
}
