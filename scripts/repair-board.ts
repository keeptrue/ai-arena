/**
 * Recompute one match's declared board ledger from the submissions on record.
 *
 * The event stream is append-only: this script never edits or deletes anything.
 * It walks the rounds that were judged, settles them again with the blueprint
 * snapshot the match froze, and appends a `board.reconciled` event for every
 * round whose stored reading disagrees with the ledger. The UI folds those in,
 * so a match that was played while the judge kept the books shows the true
 * numbers — and `judgements` keeps the judge's original words for the audit.
 *
 *   bun run scripts/repair-board.ts <matchId> [--dry-run] [--force]
 *
 * --dry-run  print the diff, write nothing
 * --force    allow a match that is still running (its in-memory state will keep
 *            using the old numbers until the process restarts)
 */

import { parseBlueprint } from "../src/engine/blueprint";
import { applySettlement, foldBoardValues, settleRound } from "../src/engine/ledger";
import {
  appendEvent,
  eventsAfter,
  getMatch,
  getMatchBlueprint,
  getMatchRoster,
  getRulesetById,
  nextSeq,
} from "../src/db/repo";
import type { ArenaEvent, BoardSpec, BoardSettlement, RubricDimension, Settlement, TeamScoreLine } from "../src/engine/types";

const args = process.argv.slice(2);
const matchId = args.find((a) => !a.startsWith("-"));
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");

if (!matchId) {
  console.error("用法: bun run scripts/repair-board.ts <matchId> [--dry-run] [--force]");
  process.exit(1);
}

const match = getMatch(matchId);
if (!match) {
  console.error(`找不到对局 ${matchId}`);
  process.exit(1);
}
const snapshot = getMatchBlueprint(matchId);
if (!snapshot) {
  console.error(`对局 ${matchId} 没有冻结的蓝图快照`);
  process.exit(1);
}

if (snapshot.mode === "werewolf") {
  console.error("九人局没有评分账本，不需要修复。");
  process.exit(1);
}
const blueprint = parseBlueprint(snapshot);
const frozenBoard = blueprint.board;
if (!frozenBoard) {
  console.error("这局的蓝图没有 board，没有可重算的东西。");
  process.exit(1);
}

/**
 * Matches played before the ledger shipped froze a snapshot without `board.settle`.
 * Borrowing the ledger from the match's own ruleset is the only way to repair them.
 * It is safe because it only fills in the deterministic settlement the rules already
 * described in prose — the slots, meters and rubric stay the frozen ones. Anything
 * that does not line up is refused rather than guessed.
 */
function borrowSettlement(): { settle: BoardSettlement; dimensions: RubricDimension[] } | null {
  const live = getRulesetById(match!.rulesetId)?.blueprint;
  if (!live || live.mode === "werewolf" || live.mode === "coup") return null;
  const settle = live.board?.settle;
  if (!settle) return null;

  const slot = blueprint.submission.slots.find((s) => s.key === settle.by);
  if (!slot || slot.type !== "choice") return null;
  const meters = new Set(frozenBoard!.meters.map((m) => m.key));
  const keys = settle.cells.flatMap((cell) => cell.delta.flatMap((side) => Object.keys(side)));
  if (keys.some((k) => !meters.has(k))) return null;
  if (!slot.choices?.includes(settle.forfeit)) return null;

  console.warn(
    `! 快照里没有账本：借用当前规则「${live.name}」的 settle / derive（只补齐确定性结算，不改规则正文与维度权重）`,
  );
  return { settle, dimensions: live.rubric.dimensions };
}

const borrowed = frozenBoard.settle ? null : borrowSettlement();
if (!frozenBoard.settle && !borrowed) {
  console.error("这局的蓝图没有 board.settle 账本，当前规则里也没有可借用的结算表。");
  process.exit(1);
}

const settleSpec = frozenBoard.settle ?? borrowed!.settle;
const dimensionSpec = borrowed ? borrowed.dimensions : blueprint.rubric.dimensions;
const board: BoardSpec = { ...frozenBoard, settle: settleSpec };
if (match.status === "running" && !force) {
  console.error("对局仍在运行：内存里的状态会和事件流分叉。先跑完或中止，或者加 --force。");
  process.exit(1);
}

const roster = getMatchRoster(matchId);
const teams = roster.teams.map((t) => ({ id: t.id, idx: t.idx, name: t.name }));
const teamIds = [...teams].sort((a, b) => a.idx - b.idx).map((t) => t.id);
if (teams.length !== 2) {
  console.error(`这项工作只支持两方对局，这局有 ${teams.length} 方。`);
  process.exit(1);
}

const events = eventsAfter(matchId, 0, 200000) as ArenaEvent[];

/** round → teamId → the value that side submitted (`null` = forfeited / missing). */
const movesByRound = new Map<number, Map<string, string | null>>();
/** round → the score lines the runtime stored when it judged. */
const verdictsByRound = new Map<number, { scores: TeamScoreLine[]; summary: string }>();

for (const event of events) {
  const payload = event.payload as Record<string, any>;
  const round = Number(payload.round);
  if (!Number.isFinite(round)) continue;
  if (event.type === "seat.submitted" || event.type === "seat.forfeit") {
    const moves = movesByRound.get(round) ?? new Map<string, string | null>();
    const teamId = event.teamId;
    if (teamId) {
      const value =
        event.type === "seat.submitted" ? (payload.content?.[settleSpec.by] ?? null) : null;
      moves.set(teamId, value === null ? null : String(value));
    }
    movesByRound.set(round, moves);
  }
  if (event.type === "round.verdict") {
    verdictsByRound.set(round, {
      scores: (payload.scores ?? []) as TeamScoreLine[],
      summary: typeof payload.publicSummary === "string" ? payload.publicSummary : "",
    });
  }
}

const judgedRounds = [...verdictsByRound.keys()].sort((a, b) => a - b);
if (judgedRounds.length === 0) {
  console.log("这局还没有任何裁决，没什么可修的。");
  process.exit(0);
}

let pending = nextSeq(matchId);
let repaired = 0;
const settledRounds: Array<{ round: number; settlement: Settlement }> = [];

const sameMeters = (a: Record<string, number> | undefined, b: Record<string, number> | undefined) =>
  board.meters.every((m) => (a?.[m.key] ?? null) === (b?.[m.key] ?? null));

for (const round of judgedRounds) {
  const stored = verdictsByRound.get(round)!;
  const prior = foldBoardValues(board, teamIds, settledRounds);
  const moves = teamIds.map((teamId) => ({
    teamId,
    value: movesByRound.get(round)?.get(teamId) ?? null,
  }));

  const settlement = settleRound({ board, teams, moves, prior, round });
  if (!settlement) {
    console.warn(`R${round}: 账本里找不到对应的组合，跳过`);
    continue;
  }
  settledRounds.push({ round, settlement });

  const merged = applySettlement({
    settlement,
    board,
    dimensions: dimensionSpec,
    scores: stored.scores,
  });

  const drift = merged.scores.some((line) => {
    const before = stored.scores.find((s) => s.teamId === line.teamId);
    if (!sameMeters(before?.state, line.state)) return true;
    return dimensionSpec.some(
      (d) => d.derive && (before?.dimensions?.[d.key] ?? null) !== (line.dimensions?.[d.key] ?? null),
    );
  });
  if (!drift) continue;

  const teamScores = Object.fromEntries(merged.scores.map((line) => [line.teamId, line.weighted]));
  const detail = merged.scores
    .map((line) => {
      const before = stored.scores.find((s) => s.teamId === line.teamId);
      const name = teams.find((t) => t.id === line.teamId)?.name ?? line.teamId;
      const was = board.meters.map((m) => `${m.label} ${before?.state?.[m.key] ?? "—"}`).join(" ");
      const now = board.meters.map((m) => `${m.label} ${line.state?.[m.key] ?? "—"}`).join(" ");
      return `${name}: ${was}  →  ${now}`;
    })
    .join(" | ");

  if (dryRun) {
    console.log(`R${round} 会修正 —— ${detail}`);
    continue;
  }

  appendEvent(matchId, {
    seq: pending++,
    ts: Date.now(),
    type: "board.reconciled",
    teamId: undefined,
    payload: {
      round,
      settlement,
      scores: merged.scores,
      teamScores,
      reason: "ledger_repair",
    },
  });
  repaired += 1;
  console.log(`R${round} 已修正 —— ${detail}`);
  console.log(`       ${settlement.summary}`);
}

console.log(
  dryRun
    ? `\n${matchId}: 试算完成，未写入。去掉 --dry-run 即可落库。`
    : `\n${matchId}: 追加了 ${repaired} 条 board.reconciled 事件（seq ${pending - repaired}…${pending - 1}）。`,
);
