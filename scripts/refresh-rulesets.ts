/**
 * Re-import the built-in rulesets from `rulesets/*.blueprint.json`.
 *
 * `syncBuiltinRulesets` deliberately never overwrites an existing row — once a
 * built-in is seeded, the UI owns it. That is the right default for hand-edited
 * rules, but it also means a shipped change to a built-in blueprint (a new
 * `board.settle` ledger, say) would never reach an existing install. This script
 * is the explicit escape hatch.
 *
 * Matches freeze `blueprint_snapshot_json`, so re-importing never changes how a
 * finished match was judged.
 *
 *   bun run db:rulesets            # all built-ins
 *   bun run db:rulesets <slug>...  # only these
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseAnyBlueprint } from "../src/engine/game";
import { upsertRuleset } from "../src/db/repo";
import { RULESETS_DIR } from "../src/lib/rulesets";

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = (await readdir(RULESETS_DIR).catch(() => [] as string[])).filter((f) =>
  f.endsWith(".blueprint.json"),
);

let refreshed = 0;
for (const file of files) {
  const slug = file.replace(/\.blueprint\.json$/, "");
  if (only.length && !only.includes(slug)) continue;
  try {
    const raw = JSON.parse(await readFile(path.join(RULESETS_DIR, file), "utf8"));
    const blueprint = parseAnyBlueprint(raw);
    const sourceMd = await readFile(path.join(RULESETS_DIR, `${slug}.md`), "utf8").catch(() => "");
    const id = upsertRuleset({
      slug,
      name: blueprint.name,
      sourceMd,
      blueprint,
      blueprintHash: "",
      compiledAt: Date.now(),
      compiledBy: "builtin",
    });
    const shape =
      blueprint.mode === "werewolf"
        ? `${blueprint.seats} 人，九人局`
        : blueprint.mode === "coup"
          ? `${blueprint.seats} 人，政变`
          : `${blueprint.rounds} 轮，${blueprint.board?.settle ? "引擎账本" : "裁判记账"}`;
    console.log(`${slug} → ${id}（${shape}）`);
    refreshed += 1;
  } catch (err) {
    console.error(`! ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log(`${refreshed} 条内置规则已重载`);
