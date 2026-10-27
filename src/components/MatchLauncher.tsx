"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { pickLineups } from "@/lib/lineup";
import type { LineupRecord, ResolvedLineup } from "@/lib/lineup";
import { mirrorSides, rosterTwins, seatList } from "@/lib/seats";
import type { WerewolfRoleId } from "@/engine/werewolf/types";

export interface RuleSummary {
  id: string;
  slug: string;
  name: string;
  kind: "rubric" | "werewolf" | "coup";
  rounds: number;
  seats: number;
  tagline: string;
  dimensions: Array<{ key: string; label: string; weight: number }>;
  slots: Array<{ key: string; label: string; reveal: string }>;
}

export interface PoolModel {
  id: string;
  display: string;
  providerId: string;
  providerName: string;
  /** Provider-side model string; snapshots are matched on this pair, not on `id`. */
  modelId: string;
  inContenderPool: boolean;
  inJudgePool: boolean;
  enabled: boolean;
}

interface TeamDraft {
  name: string;
  modelIds: string[];
}

const PRESETS: Array<{ label: string; sizes: number[] }> = [
  { label: "1v1", sizes: [1, 1] },
  { label: "1v2", sizes: [1, 2] },
  { label: "2v2", sizes: [2, 2] },
  { label: "1v1v1", sizes: [1, 1, 1] },
  { label: "2v1v1", sizes: [2, 1, 1] },
];

/** Last explicit judge, remembered per browser so a repeated setup is two clicks. */
const JUDGE_KEY = "arena.judgeModelId";

const WW_ROLES: Array<{ id: WerewolfRoleId; label: string }> = [
  { id: "wolf", label: "狼人" },
  { id: "villager", label: "村民" },
  { id: "seer", label: "预言家" },
  { id: "witch", label: "女巫" },
  { id: "hunter", label: "猎人" },
];
const WW_DECK: WerewolfRoleId[] = [
  "wolf", "wolf", "wolf",
  "villager", "villager", "villager",
  "seer", "witch", "hunter",
];

export function MatchLauncher({
  rulesets,
  models,
  lineups,
}: {
  rulesets: RuleSummary[];
  models: PoolModel[];
  lineups: LineupRecord[];
}) {
  const router = useRouter();
  const [pendingNav, startTransition] = useTransition();
  const [rulesetId, setRulesetId] = useState(rulesets[0]?.id ?? "");
  const [preset, setPreset] = useState(0);
  const [mode, setMode] = useState<"random" | "manual">("random");
  const [manual, setManual] = useState<TeamDraft[]>([
    { name: "", modelIds: [] },
    { name: "", modelIds: [] },
  ]);
  const [judgeModelId, setJudgeModelId] = useState("auto");
  const [seed, setSeed] = useState("");
  const [wwSeats, setWwSeats] = useState<Array<{ modelId: string }>>(
    Array.from({ length: 9 }, () => ({ modelId: "" })),
  );
  const [coupSeats, setCoupSeats] = useState<Array<{ modelId: string }>>(
    Array.from({ length: 4 }, () => ({ modelId: "" })),
  );
  const [coupCommentary, setCoupCommentary] = useState("");
  // The narrator is what makes the table readable; default it on until the user
  // explicitly turns it off (picking "关闭" must not be undone by a re-render).
  const commentaryPicked = useRef(false);
  const [dealMode, setDealMode] = useState<"engine" | "manual" | "judge">("engine");
  const [manualRoles, setManualRoles] = useState<WerewolfRoleId[]>([...WW_DECK]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pool = useMemo(
    () => models.filter((m) => m.enabled && m.inContenderPool),
    [models],
  );
  const judgePool = useMemo(
    () => models.filter((m) => m.enabled && m.inJudgePool),
    [models],
  );
  // Every model select groups by provider: a flat list of 30 names is unreadable,
  // and "同一接入方的两个模型" is exactly the distinction a roster cares about.
  const poolGroups = useMemo(() => groupByProvider(pool), [pool]);

  useEffect(() => {
    if (commentaryPicked.current || coupCommentary) return;
    const first = poolGroups.flatMap((group) => group.models)[0];
    if (first) setCoupCommentary(first.id);
  }, [poolGroups, coupCommentary]);
  const judgeGroups = useMemo(() => groupByProvider(judgePool), [judgePool]);

  // Resolved after mount only: the server's clock and timezone must not leak into
  // the markup, or hydration would flap between two different labels.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const roster = useMemo(() => pickLineups(lineups, pool), [lineups, pool]);
  const offered = roster.restorable ?? roster.latest;
  const skipped =
    offered && roster.latest && offered.matchId !== roster.latest.matchId ? roster.latest : null;

  // Restore only if the saved model still sits in the judge pool; otherwise stay auto.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(JUDGE_KEY);
      if (saved && judgePool.some((m) => m.id === saved)) setJudgeModelId(saved);
    } catch {
      /* storage can be unavailable (private mode) — auto is a fine fallback */
    }
  }, [judgePool]);

  function pickJudge(id: string) {
    setJudgeModelId(id);
    try {
      if (id === "auto") window.localStorage.removeItem(JUDGE_KEY);
      else window.localStorage.setItem(JUDGE_KEY, id);
    } catch {
      /* persistence is best-effort */
    }
  }

  const selected = rulesets.find((r) => r.id === rulesetId) ?? rulesets[0];
  const isWerewolf = selected?.kind === "werewolf";
  const isCoup = selected?.kind === "coup";
  const sizes = PRESETS[preset].sizes;
  const seatCount = mode === "random" ? sizes.reduce((a, b) => a + b, 0) : manual.reduce((a, t) => a + t.modelIds.length, 0);

  const coupChosen = coupSeats.filter((s) => s.modelId);
  // Any seat may hold any model — a mirror table (the same brain twice) is a
  // legitimate stress test. Duplicates are labelled in the dropdown and on the
  // seat card; they never disable an option and never block the start button.
  const coupTwins = rosterTwins(coupSeats.map((s) => s.modelId));

  const wwChosen = wwSeats.filter((s) => s.modelId);
  const wwTwins = rosterTwins(wwSeats.map((s) => s.modelId));
  const roleCounts = manualRoles.reduce<Record<string, number>>((acc, role) => {
    acc[role] = (acc[role] ?? 0) + 1;
    return acc;
  }, {});
  const wwRolesValid =
    manualRoles.length === 9 &&
    roleCounts.wolf === 3 &&
    roleCounts.villager === 3 &&
    roleCounts.seer === 1 &&
    roleCounts.witch === 1 &&
    roleCounts.hunter === 1;
  // Every nine-seat match ends with a blind review, and the review needs a judge
  // ballot — so the judge is required for all three deal modes. It may be one of
  // the seated models: it then holds both its seat ballot and the judge ballot.
  // Auto still prefers a model off the table, but an explicit pick wins.
  const wwJudge = judgePool.find((m) => m.id === judgeModelId) ?? null;
  const modelKey = (m: { providerId: string; modelId: string }) => `${m.providerId}/${m.modelId}`;
  const wwSeated = new Set(
    wwSeats
      .map((seat) => pool.find((x) => x.id === seat.modelId))
      .filter((m): m is PoolModel => !!m)
      .map((m) => modelKey(m)),
  );
  const wwJudgeSeated = !!wwJudge && wwSeated.has(modelKey(wwJudge));
  const wwJudgeAllSeated =
    judgePool.length > 0 && judgePool.every((m) => wwSeated.has(modelKey(m)));
  const wwJudgeOk = judgePool.length > 0;
  const wwProblem = !isWerewolf
    ? null
    : pool.length === 0
      ? "选手池里没有可用模型——去配置页填 Key 并拉取模型。"
      : wwChosen.length < 9
        ? `还差 ${9 - wwChosen.length} 个座位没选`
        : dealMode === "manual" && !wwRolesValid
          ? "手动身份必须 3 狼、3 民、预女猎各 1"
          : judgePool.length === 0
            ? "九人局需要一个裁判：去配置页给某个模型打开「裁判」（赛后盲评要用）"
            : null;

  const canStart = !selected
    ? false
    : isWerewolf
      ? pool.length > 0 &&
        wwChosen.length === 9 &&
        wwChosen.every((s) => pool.some((m) => m.id === s.modelId)) &&
        (dealMode !== "manual" || wwRolesValid) &&
        wwJudgeOk
      : isCoup
        ? coupSeats.every((s) => !!s.modelId && pool.some((m) => m.id === s.modelId))
        : pool.length > 0 &&
          (mode === "random"
            ? pool.length >= seatCount
            : manual.length >= 2 && manual.every((t) => t.modelIds.length >= 1));

  const chosenJudge = judgePool.find((m) => m.id === judgeModelId) ?? null;
  // Only a manual roster is known before the draw, so only then can we name the clash.
  const clashSeats =
    mode === "manual" && chosenJudge
      ? manual.reduce(
          (n, team) =>
            n +
            team.modelIds.filter(
              (id) => pool.find((m) => m.id === id)?.providerId === chosenJudge.providerId,
            ).length,
          0,
        )
      : 0;

  /** Rubric rosters are mirrors too: one model may hold seats on several sides. */
  const manualMirrors = useMemo(() => mirrorSides(manual), [manual]);
  const manualCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const team of manual) {
      for (const id of team.modelIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [manual]);

  /** Distinct providers on one side — the thing a balanced roster is actually made of. */
  function providerNamesOf(modelIds: string[]): string[] {
    const names = modelIds
      .map((id) => pool.find((m) => m.id === id)?.providerName)
      .filter((n): n is string => !!n);
    return [...new Set(names)];
  }

  function addToTeam(teamIdx: number, modelId: string) {
    setManual((prev) =>
      prev.map((t, i) =>
        i === teamIdx && t.modelIds.length < 4 ? { ...t, modelIds: [...t.modelIds, modelId] } : t,
      ),
    );
  }

  /** Seats are addressed by slot: the same model may appear twice in one side. */
  function removeFromTeam(teamIdx: number, slot: number) {
    setManual((prev) =>
      prev.map((t, i) =>
        i === teamIdx ? { ...t, modelIds: t.modelIds.filter((_, j) => j !== slot) } : t,
      ),
    );
  }

  function setWwSeat(index: number, modelId: string) {
    setWwSeats((prev) => prev.map((seat, i) => (i === index ? { modelId } : seat)));
  }

  function setWwRole(index: number, role: WerewolfRoleId) {
    setManualRoles((prev) => prev.map((r, i) => (i === index ? role : r)));
  }

  function setCoupSeat(index: number, modelId: string) {
    setCoupSeats((prev) => prev.map((seat, i) => (i === index ? { modelId } : seat)));
  }

  function fillCoupSeats() {
    setCoupSeats((prev) => fillEmptySeats(prev, pool));
  }

  function fillWwSeats() {
    setWwSeats((prev) => fillEmptySeats(prev, pool));
  }

  /** Restore a past roster verbatim: names and seat order included, rules left alone. */
  function applyLineup(lineup: ResolvedLineup) {
    setManual(lineup.teams.map((t) => ({ name: t.name, modelIds: t.modelIds })));
    setMode("manual");
    setError(null);
  }

  async function start() {
    setError(null);
    setBusy(true);
    try {
      const judge = judgeModelId === "auto" ? undefined : judgeModelId;
      const body = isCoup
        ? {
            rulesetId: selected.id,
            seats: coupSeats.map((s) => ({ modelId: s.modelId })),
            commentaryModelId: coupCommentary || undefined,
            seed: seed.trim() || undefined,
          }
        : isWerewolf
        ? {
            rulesetId: selected.id,
            seats: wwSeats.map((s) => ({ modelId: s.modelId })),
            deal: {
              mode: dealMode,
              ...(dealMode === "manual" ? { roles: manualRoles } : {}),
            },
            judgeModelId: judge,
            seed: seed.trim() || undefined,
          }
        : mode === "random"
          ? { rulesetId: selected.id, teamSizes: sizes, seed: seed.trim() || undefined, judgeModelId: judge }
          : {
              rulesetId: selected.id,
              teams: manual.map((t) => ({ name: t.name || undefined, modelIds: t.modelIds })),
              seed: seed.trim() || undefined,
              judgeModelId: judge,
            };
      const res = await fetch("/api/matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { matchId?: string; kind?: "rubric" | "werewolf" | "coup"; error?: string };
      if (!res.ok || !data.matchId) throw new Error(data.error ?? "开局失败");
      startTransition(() => router.push(`/${data.kind === "werewolf" ? "table" : data.kind === "coup" ? "coup" : "arena"}/${data.matchId}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const loading = busy || pendingNav;

  if (rulesets.length === 0) {
    return (
      <p className="panel px-5 py-8 text-[13px] text-fg-faint">
        还没有可用的规则。去 <a className="text-jade underline underline-offset-4" href="/rulesets">规则</a> 写一条。
      </p>
    );
  }

  return (
    <div className="space-y-7">
      {/* ruleset */}
      <section>
        <SectionTitle index="01" title="选规则" hint="规则决定每轮交什么、怎么算赢。" />
        <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {rulesets.map((r) => {
            const active = r.id === rulesetId;
            return (
              <button
                key={r.id}
                onClick={() => setRulesetId(r.id)}
                className={`group rounded-xl border p-4 text-left transition ${
                  active
                    ? "border-jade/50 bg-jade/[0.06]"
                    : "border-line bg-ink-1/60 hover:border-line-strong"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className={`text-[14px] font-medium ${active ? "text-jade" : "text-fg"}`}>{r.name}</span>
                  <span className="mono text-[10px] text-fg-faint">
                    {r.kind === "werewolf" || r.kind === "coup" ? `${r.seats} 人` : `${r.rounds} 轮`}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-fg-dim">{r.tagline}</p>
                <div className="mt-2.5 flex flex-wrap gap-1">
                  {r.kind === "coup" ? (
                    <>
                      <span className="rounded border border-amber/30 bg-amber/10 px-1.5 py-0.5 text-[10px] text-amber">
                        政变
                      </span>
                      <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint">
                        4 人 · 15 张牌
                      </span>
                      <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint">
                        质疑链
                      </span>
                    </>
                  ) : r.kind === "werewolf" ? (
                    <>
                      <span className="rounded border border-blood/30 bg-blood/10 px-1.5 py-0.5 text-[10px] text-blood">
                        九人局
                      </span>
                      <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint">
                        3 狼 · 3 民 · 预女猎
                      </span>
                      <span className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint">
                        无警长
                      </span>
                    </>
                  ) : (
                    r.slots.map((s) => (
                      <span
                        key={s.key}
                        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint"
                      >
                        {s.label}
                        {s.reveal === "secret" ? "🔒" : ""}
                      </span>
                    ))
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* roster */}
      <section>
        <SectionTitle
          index="02"
          title={isWerewolf ? "九人桌" : isCoup ? "四人桌" : "编队"}
          hint={
            isWerewolf
              ? `选手池里可用 ${pool.length} 个模型 · ${poolGroups.length} 个接入方；9 个座位，同一模型可以坐多席`
              : isCoup
                ? `选手池里可用 ${pool.length} 个模型 · ${poolGroups.length} 个接入方；4 个座位，同一模型可以坐多席`
                : `选手池里可用 ${pool.length} 个模型 · ${poolGroups.length} 个接入方${judgePool.length === 0 ? "（还没有裁判模型，终局裁决会失败）" : ""}`
          }
        />
        {isWerewolf ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-md border border-line bg-ink-1 p-0.5">
                {(["engine", "manual", "judge"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setDealMode(m)}
                    className={`rounded px-3 py-1.5 text-[12px] transition ${
                      dealMode === m ? "bg-ink-3 text-fg" : "text-fg-faint hover:text-fg-dim"
                    }`}
                  >
                    {m === "engine" ? "引擎随机" : m === "manual" ? "手动指定" : "法官发牌"}
                  </button>
                ))}
              </div>
              <button
                onClick={fillWwSeats}
                className="rounded border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg"
              >
                一键填满
              </button>
              <button
                onClick={() => {
                  setWwSeats(Array.from({ length: 9 }, () => ({ modelId: "" })));
                  setManualRoles([...WW_DECK]);
                }}
                className="rounded border border-line px-3 py-1.5 text-[12px] text-fg-faint transition hover:border-line-strong hover:text-fg-dim"
              >
                清空
              </button>
              <span className="mono text-[11px] text-fg-faint">已选 {wwChosen.length}/9</span>
              {wwTwins.groups.length > 0 && (
                <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[10px] text-amber">
                  自我对弈 · {wwTwins.groups.length} 个模型重复
                </span>
              )}
            </div>

            <ProviderRail groups={poolGroups} />

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {wwSeats.map((seat, i) => {
                const mark = wwTwins.marks[i];
                return (
                  <div
                    key={i}
                    className={`rounded-lg border p-2.5 ${
                      mark ? "border-amber/40 bg-amber/[0.05]" : "border-line bg-ink-1/60"
                    }`}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="mono text-[11px] text-fg-faint">#{i + 1}</span>
                      <span className="text-[11px] text-fg-dim">座位</span>
                      {mark && (
                        <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[10px] text-amber">
                          同模型 ×{mark.length + 1}
                        </span>
                      )}
                      <span className="mono ml-auto truncate text-[10px] text-fg-faint">
                        {pool.find((m) => m.id === seat.modelId)?.providerName ?? "未选"}
                      </span>
                    </div>
                    <select
                      aria-label={`第 ${i + 1} 号座位模型`}
                      value={seat.modelId}
                      onChange={(e) => setWwSeat(i, e.target.value)}
                      className="w-full rounded border border-line bg-ink-0 px-2 py-1.5 text-[11px] text-fg-dim outline-none focus:border-jade/40"
                    >
                      <option value="">选择模型</option>
                      {poolGroups.map((group) => (
                        <optgroup key={group.providerId} label={providerLabel(group)}>
                          {group.models.map((m) => {
                            const elsewhere = (wwTwins.byModel.get(m.id) ?? []).filter(
                              (j) => j !== i,
                            );
                            return (
                              <option key={m.id} value={m.id}>
                                {seatOptionLabel(m.display, elsewhere, m.id === seat.modelId)}
                              </option>
                            );
                          })}
                        </optgroup>
                      ))}
                    </select>
                    {mark && (
                      <p className="mt-1 text-[10px] leading-relaxed text-amber/90">
                        同一模型还坐在 {seatList(mark)}
                      </p>
                    )}
                    {dealMode === "manual" && (
                      <select
                        aria-label={`第 ${i + 1} 号座位身份`}
                        value={manualRoles[i]}
                        onChange={(e) => setWwRole(i, e.target.value as WerewolfRoleId)}
                        className="mt-1.5 w-full rounded border border-line bg-ink-0 px-2 py-1.5 text-[11px] text-fg-dim outline-none focus:border-jade/40"
                      >
                        {WW_ROLES.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>

            {wwTwins.groups.length > 0 && (
              <p className="rounded-lg border border-amber/30 bg-amber/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber/90">
                自我对弈：
                {wwTwins.groups
                  .map((g) => `「${modelLabel(pool, g.modelId)}」坐 ${seatList(g.seats)}`)
                  .join(" · ")}
                。同一模型的两个座位牌风几乎一样，胜负更多落在发牌与座位序上；两张座位票与自评都按座位独立计算。
              </p>
            )}

            {dealMode === "manual" && (
              <p className="text-[11px] text-fg-faint">
                身份计数：狼 {roleCounts.wolf ?? 0}/3 · 民 {roleCounts.villager ?? 0}/3 · 神{" "}
                {(roleCounts.seer ?? 0) + (roleCounts.witch ?? 0) + (roleCounts.hunter ?? 0)}/3
              </p>
            )}
            <p className="text-[11px] leading-relaxed text-fg-faint">
              每天约 20–30 次调用，一局约 50–90 分钟；终局额外 10 次评分调用。
              座位可以重复使用同一个模型（自我对弈会在座位上标出「同模型」）；引擎发牌用种子洗牌，同种子可复现。
            </p>
          </div>
        ) : isCoup ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={fillCoupSeats}
                className="rounded border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg"
              >
                一键填满
              </button>
              <button
                onClick={() => setCoupSeats(Array.from({ length: 4 }, () => ({ modelId: "" })))}
                className="rounded border border-line px-3 py-1.5 text-[12px] text-fg-faint transition hover:border-line-strong hover:text-fg-dim"
              >
                清空
              </button>
              <span className="mono text-[11px] text-fg-faint">已选 {coupChosen.length}/4</span>
              {coupTwins.groups.length > 0 && (
                <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[10px] text-amber">
                  自我对弈 · {coupTwins.groups.length} 个模型重复
                </span>
              )}
            </div>

            <ProviderRail groups={poolGroups} />

            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {coupSeats.map((seat, i) => {
                const mark = coupTwins.marks[i];
                return (
                  <div
                    key={i}
                    className={`rounded-lg border p-2.5 ${
                      mark ? "border-amber/40 bg-amber/[0.05]" : "border-line bg-ink-1/60"
                    }`}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="mono text-[11px] text-fg-faint">#{i + 1}</span>
                      <span className="text-[11px] text-fg-dim">座位</span>
                      {mark && (
                        <span className="rounded border border-amber/40 bg-amber/10 px-1.5 py-0.5 text-[10px] text-amber">
                          同模型 ×{mark.length + 1}
                        </span>
                      )}
                      <span className="mono ml-auto truncate text-[10px] text-fg-faint">
                        {pool.find((m) => m.id === seat.modelId)?.providerName ?? "未选"}
                      </span>
                    </div>
                    <select
                      aria-label={`第 ${i + 1} 号座位模型`}
                      value={seat.modelId}
                      onChange={(e) => setCoupSeat(i, e.target.value)}
                      className="w-full rounded border border-line bg-ink-0 px-2 py-1.5 text-[11px] text-fg-dim outline-none focus:border-jade/40"
                    >
                      <option value="">选择模型</option>
                      {poolGroups.map((group) => (
                        <optgroup key={group.providerId} label={providerLabel(group)}>
                          {group.models.map((m) => {
                            const elsewhere = (coupTwins.byModel.get(m.id) ?? []).filter(
                              (j) => j !== i,
                            );
                            return (
                              <option key={m.id} value={m.id}>
                                {seatOptionLabel(m.display, elsewhere, m.id === seat.modelId)}
                              </option>
                            );
                          })}
                        </optgroup>
                      ))}
                    </select>
                    {mark && (
                      <p className="mt-1 text-[10px] leading-relaxed text-amber/90">
                        同一模型还坐在 {seatList(mark)}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {coupTwins.groups.length > 0 && (
              <p className="rounded-lg border border-amber/30 bg-amber/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber/90">
                自我对弈：
                {coupTwins.groups
                  .map((g) => `「${modelLabel(pool, g.modelId)}」坐 ${seatList(g.seats)}`)
                  .join(" · ")}
                。同一个模型的两张座位票都按座位独立计入，但两个座位拿到的是同一副牌风与判断，胜负更依赖手牌与座位序。
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-ink-1/60 px-3 py-2.5">
              <span className="text-[12px] text-fg-dim">AI 解说</span>
              <select
                aria-label="解说模型"
                value={coupCommentary}
                onChange={(e) => {
                  commentaryPicked.current = true;
                  setCoupCommentary(e.target.value);
                }}
                className="min-w-56 rounded border border-line bg-ink-0 px-2 py-1.5 text-[11px] text-fg-dim outline-none focus:border-jade/40"
              >
                <option value="">关闭（不推荐：观众看不到动机）</option>
                {poolGroups.map((group) => (
                  <optgroup key={group.providerId} label={providerLabel(group)}>
                    {group.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <span className="text-[11px] leading-relaxed text-fg-faint">
                读全牌、只给观众看，绝不进玩家 prompt；可以和座位上的模型重复。
              </span>
            </div>

            <p className="text-[11px] leading-relaxed text-fg-faint">
              四人桌：每人两张暗牌、两枚金币，15 张身份牌。一局约 120–180 次调用。
              座位可以重复使用同一个模型（会在座位上标出「同模型」）；解说与评分裁判在规则文件的{" "}
              <code className="mono">commentary</code> /<code className="mono">review</code> 段里配置。
            </p>
          </div>
        ) : (
          <>
        <div className="mb-3">
          <ProviderRail groups={poolGroups} />
        </div>
        {offered && (
          <div className="mb-3 rounded-lg border border-line bg-ink-1/60 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="label">{skipped ? "更早的一次" : "上一次"}</span>
              {now !== null && (
                <span className="mono text-[10px] text-fg-faint">
                  {formatAgo(now - offered.createdAt)}
                </span>
              )}
              <span className="mono text-[10px] text-fg-faint">
                {offered.teams.length} 方 · {offered.teams.reduce((n, t) => n + t.modelIds.length, 0)} 席
              </span>
              <button
                onClick={() => applyLineup(offered)}
                disabled={!offered.usable}
                title={offered.usable ? "把这套阵容灌回手动编队" : lineupProblem(offered)}
                className="ml-auto rounded border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade transition hover:border-jade/70 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-fg-faint"
              >
                {skipped ? "沿用这一次" : "沿用上一次"}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {offered.teams.map((team, ti) => (
                <span
                  key={`${team.name}-${ti}`}
                  className="rounded border border-line px-2 py-0.5 text-[11px] text-fg-dim"
                >
                  <span
                    className="mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
                    style={{ backgroundColor: team.color }}
                  />
                  <span className="text-fg">{team.name || `第 ${ti + 1} 方`}</span>
                  <span className="mx-1 text-fg-faint">·</span>
                  {team.modelIds.map((id) => pool.find((m) => m.id === id)?.display ?? id).join(" / ")}
                </span>
              ))}
            </div>
            {skipped && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber/90">
                上一局（{formatAgoOrDate(now, skipped.createdAt)}）的编队已不可用：
                {lineupProblem(skipped)}。上面是更早的一次。
              </p>
            )}
            {!offered.usable && (
              <p className="mt-2 text-[11px] leading-relaxed text-amber/90">{lineupProblem(offered)}</p>
            )}
          </div>
        )}
        <div className="mb-3 inline-flex rounded-md border border-line bg-ink-1 p-0.5">
          {(["random", "manual"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-3 py-1.5 text-[12px] transition ${
                mode === m ? "bg-ink-3 text-fg" : "text-fg-faint hover:text-fg-dim"
              }`}
            >
              {m === "random" ? "随机抽" : "手动编"}
            </button>
          ))}
        </div>

        {mode === "random" ? (
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p, i) => {
              const enough = pool.length >= p.sizes.reduce((a, b) => a + b, 0);
              return (
                <button
                  key={p.label}
                  disabled={!enough}
                  onClick={() => setPreset(i)}
                  title={enough ? "" : "选手池里的模型不够"}
                  className={`mono rounded-md border px-3 py-1.5 text-[12px] transition ${
                    preset === i
                      ? "border-jade/50 bg-jade/10 text-jade"
                      : "border-line text-fg-dim hover:border-line-strong disabled:opacity-30"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            <span className="text-[11px] text-fg-faint">共 {seatCount} 席</span>
          </div>
        ) : (
          <div className="space-y-2.5">
            {manual.map((team, ti) => {
              const teamProviders = providerNamesOf(team.modelIds);
              const teamRepeats = [...new Set(team.modelIds)].filter(
                (id) => team.modelIds.filter((x) => x === id).length > 1,
              );
              return (
                <div
                  key={ti}
                  className={`rounded-lg border p-3 ${
                    teamRepeats.length > 0
                      ? "border-amber/40 bg-amber/[0.04]"
                      : "border-line bg-ink-1/60"
                  }`}
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <input
                      value={team.name}
                      onChange={(e) =>
                        setManual((prev) => prev.map((t, i) => (i === ti ? { ...t, name: e.target.value } : t)))
                      }
                      placeholder={`第 ${ti + 1} 方（可留空）`}
                      className="w-40 rounded border border-line bg-ink-0 px-2 py-1 text-[12px] outline-none placeholder:text-fg-faint focus:border-jade/40"
                    />
                    <span className="mono text-[10px] text-fg-faint">{team.modelIds.length}/4</span>
                    {teamProviders.length > 0 && (
                      <span className="mono min-w-0 truncate text-[10px] text-fg-faint">
                        接入方 <span className="text-fg-dim">{teamProviders.join(" · ")}</span>
                      </span>
                    )}
                    {manual.length > 2 && (
                      <button
                        onClick={() => setManual((prev) => prev.filter((_, i) => i !== ti))}
                        className="ml-auto text-[11px] text-fg-faint hover:text-blood"
                      >
                        移除该方
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {team.modelIds.map((id, slot) => {
                      const m = pool.find((x) => x.id === id);
                      // 同一个模型在整份阵容里出现不止一次：跨方是镜像，同方是自我重复。
                      const repeated = (manualCounts.get(id) ?? 0) > 1;
                      return (
                        <button
                          key={`${id}-${slot}`}
                          onClick={() => removeFromTeam(ti, slot)}
                          title={`移除 ${m?.display ?? id}`}
                          className={`mono rounded border px-2 py-0.5 text-[11px] ${
                            repeated
                              ? "border-amber/40 bg-amber/10 text-amber hover:border-blood/40 hover:text-blood"
                              : "border-jade/40 bg-jade/10 text-jade hover:border-blood/40 hover:text-blood"
                          }`}
                        >
                          {m?.display ?? id}
                          {repeated && <span className="ml-1 opacity-80">重复</span>}
                          <span className="ml-1">×</span>
                        </button>
                      );
                    })}
                    <select
                      aria-label={`第 ${ti + 1} 方添加选手`}
                      value=""
                      onChange={(e) => e.target.value && addToTeam(ti, e.target.value)}
                      className="rounded border border-line bg-ink-0 px-2 py-1 text-[11px] text-fg-dim outline-none"
                    >
                      <option value="">+ 添加选手</option>
                      {poolGroups.map((group) => (
                        <optgroup key={group.providerId} label={providerLabel(group)}>
                          {group.models.map((m) => {
                            const here = team.modelIds.filter((id) => id === m.id).length;
                            return (
                              <option key={m.id} value={m.id}>
                                {here > 0 ? `${m.display} · 本方已有 ${here} 席` : m.display}
                              </option>
                            );
                          })}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  {teamRepeats.length > 0 && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-amber/90">
                      本方自我重复：{teamRepeats.map((id) => modelLabel(pool, id)).join("、")}{" "}
                      占了不止一席，这一方的意见会被同一个模型重复一遍。
                    </p>
                  )}
                </div>
              );
            })}
            <button
              onClick={() => setManual((prev) => [...prev, { name: "", modelIds: [] }])}
              disabled={manual.length >= 8}
              className="rounded border border-dashed border-line px-3 py-1.5 text-[12px] text-fg-faint transition hover:border-line-strong hover:text-fg-dim disabled:opacity-40"
            >
              + 加一方
            </button>
            {manualMirrors.length > 0 && (
              <p className="rounded-lg border border-amber/30 bg-amber/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber/90">
                镜像对局：
                {manualMirrors
                  .map(
                    (g) =>
                      `${modelLabel(pool, g.modelId)} 在 ${g.sides.map((s) => `第 ${s + 1} 方`).join("、")} 上场`,
                  )
                  .join(" · ")}
                。两边读到同样的规则与公开战况，胜负只取决于出招与种子。
              </p>
            )}
          </div>
        )}
          </>
        )}
      </section>

      {/* judge */}
      <section>
        <SectionTitle
          index="03"
          title={isWerewolf ? "裁判（赛后盲评）" : isCoup ? "赛后评分" : "定裁判"}
          hint={
            isWerewolf
              ? "九人局的事实由引擎判定；裁判只用在终局后的盲评，一票按两票计。"
              : isCoup
                ? "政变的评分由 4 位玩家 + 1 位裁判完成，裁判从裁判池自动挑，不需要在这里指定。"
                : "默认自动：优先挑与选手不同接入方的裁判。指定的裁判在开局那一刻冻结，之后改配置影响不到这一局。"
          }
        />
        <div className="flex flex-wrap items-center gap-3">
          {!isCoup && (
          <select
            aria-label="裁判模型"
            value={judgeModelId}
            onChange={(e) => pickJudge(e.target.value)}
            className="min-w-64 rounded-md border border-line bg-ink-1 px-3 py-2 text-[12px] text-fg-dim outline-none focus:border-jade/40"
          >
            <option value="auto">自动 · 优先挑与选手不同接入方</option>
            {judgeGroups.map((group) => (
              <optgroup key={group.providerId} label={providerLabel(group)}>
                {group.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display}
                    {wwSeated.has(modelKey(m)) ? " · 也在桌上" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          )}
          <span className="text-[11px] text-fg-faint">
            {isWerewolf
              ? "裁判只拿到 1–9 号座位、终局事实卡与公开记录，看不到思考与模型名；桌上的某个模型也可以兼任，会标出「也在桌上」。"
              : isCoup
                ? "评委读到的是最终手牌、每一条宣称的真伪与质疑记录；模型名、厂商名都不进 prompt，自评不计入本人均分。"
                : "裁判读到的只有提交内容与 A / B / C 字母：思考、模型名、队名都不进 prompt。"}
          </span>
        </div>
        {judgePool.length === 0 && (
          <p className="mt-2 text-[12px] text-amber/90">
            还没有可用的裁判模型：{isWerewolf ? "赛后盲评需要一张裁判票，" : ""}去{" "}
            <a className="underline underline-offset-4" href="/setups">
              配置页
            </a>{" "}
            给某个模型打开「裁判」。
          </p>
        )}
        {isWerewolf && wwJudgeSeated && (
          <p className="mt-2 text-[12px] text-fg-faint">
            「{wwJudge?.display}」也坐在九人桌上：这一局它会以座位身份打一次牌，再单独投一张裁判票；两张票分开计入。
          </p>
        )}
        {isWerewolf && judgeModelId === "auto" && wwJudgeAllSeated && (
          <p className="mt-2 text-[12px] text-fg-faint">
            裁判池里的模型都坐在九人桌上：「自动」会让其中一位兼任裁判，座位票与裁判票分开计入。
          </p>
        )}
        {!isWerewolf && clashSeats > 0 && chosenJudge && (
          <p className="mt-2 text-[12px] text-amber/90">
            「{chosenJudge.display}」与 {clashSeats} 位选手同属「{chosenJudge.providerName}」，判分可能带自偏好。
          </p>
        )}
        {isWerewolf && (
          <p className="mt-2 text-[11px] leading-relaxed text-fg-faint">
            终局翻牌后，9 位玩家 + 1 位裁判各评一次：终局额外 10 次评分调用（默认 3 并发，单票 180 秒、总时限 6 分钟）。
            {dealMode === "judge"
              ? "「法官发牌」也用同一个裁判模型洗牌，发牌结果由引擎校验。"
              : "引擎 / 手动发牌不叫模型，裁判只用在赛后评分。"}
            裁判在开局那一刻冻结。
          </p>
        )}
      </section>

      {/* start */}
      <section className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <button
          onClick={start}
          disabled={!canStart || loading}
          className="inline-flex items-center gap-2 rounded-lg bg-jade px-6 py-3 text-[15px] font-medium text-ink-0 transition disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "开局中…" : isWerewolf ? "开桌" : "开打"}
          <span className="text-[13px] opacity-60">→</span>
        </button>
        <input
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="种子（可留空）"
          className="mono w-52 rounded-md border border-line bg-ink-1 px-3 py-2.5 text-[12px] outline-none placeholder:text-fg-faint focus:border-jade/40"
        />
        {!canStart && (
          <span className="text-[12px] text-amber/90">
            {isWerewolf
              ? wwProblem ?? "请检查九人桌配置。"
              : isCoup
                ? pool.length === 0
                  ? "选手池里没有可用模型——去配置页填 Key 并拉取模型。"
                  : "4 个座位都要选模型（同一个模型可以重复使用）。"
                : pool.length === 0
                  ? "选手池里没有可用模型——去配置页填 Key 并拉取模型。"
                  : mode === "random" && pool.length < seatCount
                    ? `随机抽需要 ${seatCount} 个模型，当前 ${pool.length} 个；切到「手动编」就能重复使用同一个模型。`
                    : "每一方至少要有一个模型。"}
          </span>
        )}
        {error && <span className="text-[12px] text-blood">{error}</span>}
      </section>
    </div>
  );
}

interface ProviderGroup {
  providerId: string;
  providerName: string;
  models: PoolModel[];
}

/**
 * Fill the empty seats: distinct models first, then wrap around the pool so a
 * mirror seat is still one click away. A seat that already holds a model is
 * never touched.
 */
function fillEmptySeats(
  seats: Array<{ modelId: string }>,
  pool: PoolModel[],
): Array<{ modelId: string }> {
  if (pool.length === 0) return seats;
  const taken = new Set(seats.map((s) => s.modelId).filter(Boolean));
  let spare = 0;
  return seats.map((seat) => {
    if (seat.modelId) return seat;
    const pick = pool.find((m) => !taken.has(m.id)) ?? pool[spare++ % pool.length];
    taken.add(pick.id);
    return { modelId: pick.id };
  });
}

/** Display name for a roster warning; a model that left the pool is still named. */
function modelLabel(pool: PoolModel[], id: string): string {
  return pool.find((m) => m.id === id)?.display ?? id;
}

/**
 * "GLM-5.2 · 已在 #3、#7" — what a duplicate choice is called in a dropdown.
 * The seat's own pick stays bare: the card already carries the 「同模型」 badge.
 */
function seatOptionLabel(display: string, twins: number[], selected: boolean): string {
  return twins.length > 0 && !selected ? `${display} · 已在 ${seatList(twins)}` : display;
}

/** Provider order follows the pool order (repo order), so it is stable across renders. */
function groupByProvider(list: PoolModel[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const m of list) {
    const group = groups.get(m.providerId) ?? {
      providerId: m.providerId,
      providerName: m.providerName,
      models: [],
    };
    group.models.push(m);
    groups.set(m.providerId, group);
  }
  return [...groups.values()];
}

function providerLabel(group: ProviderGroup, count = group.models.length): string {
  return `${group.providerName} · ${count}`;
}

/** Provider roster at a glance: which silos the pool draws from, and how many each holds. */
function ProviderRail({ groups }: { groups: ProviderGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="label">{groups.length} 个接入方</span>
      {groups.map((g) => (
        <span
          key={g.providerId}
          title={`${g.providerName} 的可用模型`}
          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-faint"
        >
          {g.providerName}
          <span className="mono ml-1 text-fg-dim">{g.models.length}</span>
        </span>
      ))}
    </div>
  );
}

function SectionTitle({ index, title, hint }: { index: string; title: string; hint: string }) {
  return (
    <div className="mb-3 flex items-baseline gap-3">
      <span className="mono text-[10px] text-fg-faint">{index}</span>
      <h2 className="text-[15px] font-medium tracking-tight">{title}</h2>
      <span className="text-[11px] text-fg-faint">{hint}</span>
    </div>
  );
}

function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** Before mount the client clock is unknown; keep the sentence readable regardless. */
function formatAgoOrDate(now: number | null, createdAt: number): string {
  return now === null ? "此前" : formatAgo(now - createdAt);
}

function lineupProblem(lineup: ResolvedLineup): string {
  const missing = lineup.issues
    .filter((i) => i.code === "model_missing" && i.detail)
    .map((i) => `「${i.detail}」`);
  if (missing.length > 0) return `${missing.join("")}已不在选手池`;
  const empty = lineup.issues.find((i) => i.code === "roster_invalid" && i.detail);
  if (empty) return `「${empty.detail}」没有选手`;
  return "没有可用的完整阵容";
}
