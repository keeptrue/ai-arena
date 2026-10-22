import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseBlueprint } from "@/engine/blueprint";
import { getRulesetBySlug, upsertRuleset } from "@/db/repo";

export const RULESETS_DIR = path.join(process.cwd(), "rulesets");

/**
 * Built-in rule sets ship as a natural-language `.md` plus a pre-compiled
 * `.blueprint.json`, so the arena is playable before any model key exists.
 * Existing rows are never overwritten — the UI owns them once seeded.
 */
export async function syncBuiltinRulesets(): Promise<{ synced: string[]; errors: string[] }> {
  const synced: string[] = [];
  const errors: string[] = [];

  const files = (await readdir(RULESETS_DIR).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".blueprint.json"),
  );

  for (const file of files) {
    const slug = file.replace(/\.blueprint\.json$/, "");
    try {
      if (getRulesetBySlug(slug)) continue;
      const raw = await readFile(path.join(RULESETS_DIR, file), "utf8");
      const blueprint = parseBlueprint(JSON.parse(raw));
      const sourceMd = await readFile(path.join(RULESETS_DIR, `${slug}.md`), "utf8").catch(() => "");
      upsertRuleset({
        slug,
        name: blueprint.name,
        sourceMd,
        blueprint,
        blueprintHash: "",
        compiledAt: null,
        compiledBy: "builtin",
      });
      synced.push(slug);
    } catch (err) {
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { synced, errors };
}

export async function readBuiltinSource(slug: string): Promise<string | null> {
  return readFile(path.join(RULESETS_DIR, `${slug}.md`), "utf8").catch(() => null);
}
