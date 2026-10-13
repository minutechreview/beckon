import { json, requireUser } from "@/lib/api";
import { assertPerAppRules, PlanLimitError } from "@/lib/plans";
import { loadPrefs, prefsInput, prefsToJSON, savePrefs } from "@/lib/notify/prefs";

export const dynamic = "force-dynamic";

export async function GET() {
  const u = await requireUser();
  if ("error" in u) return u.error;
  return json({ prefs: prefsToJSON(await loadPrefs(u.userId)) });
}

/** Fields left out keep their current value; `per_app` replaces the whole map. */
export async function PUT(req: Request) {
  const u = await requireUser();
  if ("error" in u) return u.error;
  const parsed = prefsInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request", detail: parsed.error.issues[0]?.message }, 400);
  try {
    if (parsed.data.per_app !== undefined) {
      // Resending the saved map or clearing it is always allowed; changing rules needs Pro.
      const cur = (await loadPrefs(u.userId)).perApp;
      const same = JSON.stringify(sortKeys(cur)) === JSON.stringify(sortKeys(parsed.data.per_app));
      if (!same && Object.keys(parsed.data.per_app).length > 0) await assertPerAppRules(u.userId);
    }
  } catch (err) {
    if (err instanceof PlanLimitError) return json({ error: err.code, message: err.message }, 402);
    throw err;
  }
  return json({ prefs: prefsToJSON(await savePrefs(u.userId, parsed.data)) });
}

function sortKeys(o: Record<string, unknown>): unknown {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v && typeof v === "object" ? sortKeys(v as Record<string, unknown>) : v]));
}
