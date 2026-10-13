import { readFile } from "node:fs/promises";
import path from "node:path";
import { releaseRepo } from "@/lib/config";

export const dynamic = "force-dynamic";

/** The installer, with the release repository filled in. Plain text so `curl | sh` and browsers both work. */
export async function GET() {
  const script = await readFile(path.join(process.cwd(), "install", "install.sh"), "utf8");
  return new Response(script.replaceAll("@@REPO@@", releaseRepo()), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
