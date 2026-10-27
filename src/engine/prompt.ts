/**
 * Prompt assembly.
 *
 * Two hard rules live here:
 *   1. Thinking never leaves the seat — opponents and the judge only see submissions.
 *   2. The judge never sees identities — no model names, provider names, or team names.
 */

import {
  renderPromptTemplate,
  resolvePromptBody,
  withGlobalAddendum,
  type PromptOverrides,
} from "./prompt-templates";
import type {
  Blueprint,
  BoardSpec,
  BlueprintSlot,
  MatchState,
  ParticipantState,
  RoundRecord,
  RubricDimension,
  Settlement,
} from "./types";

export interface PromptBundle {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string; cacheAt?: number }>;
}

const TYPE_LABEL: Record<BlueprintSlot["type"], string> = {
  text: "文本",
  number: "数字",
  choice: "选项",
};

function slotLine(slot: BlueprintSlot): string {
  const bits = [`\`${slot.key}\`「${slot.label}」`, TYPE_LABEL[slot.type], slot.required ? "必填" : "可选"];
  bits.push(slot.reveal === "public" ? "本轮结束后公开" : "仅裁判可见");
  if (slot.type === "choice" && slot.choices?.length) bits.push(`取值 ${slot.choices.join(" / ")}`);
  const head = `- ${bits.join(" · ")}`;
  return slot.hint ? `${head}\n    ${slot.hint}` : head;
}

function renderContent(slots: BlueprintSlot[], content: Record<string, unknown>, redactSecret: boolean): string {
  const parts = slots
    .filter((s) => !(redactSecret && s.reveal === "secret"))
    .map((s) => {
      const value = content[s.key];
      if (value === undefined) return null;
      return `${s.label}：${typeof value === "number" ? value : String(value)}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join("；") : "（无）";
}

function renderHistory(
  blueprint: Blueprint,
  history: RoundRecord[],
  opts: {
    anonymise?: (teamId: string) => string;
    includeThinking?: boolean;
    /** Participants must not learn past secret slots; the judge sees everything. */
    redactSecret?: boolean;
    /** Declared in the blueprint: the board read-out goes into history. */
    board?: BoardSpec;
    /**
     * Judge mode. Letters are re-drawn every round, so past prose (which carries the
     * *old* letters next to numbers) is never shown — a model cannot tell which side
     * an old "A 15" belonged to, and guessing is how blood lands on the wrong team.
     */
    blind?: boolean;
  } = {},
): string {
  if (history.length === 0) return "（还没有开打。）";
  const label = opts.anonymise ?? ((id: string) => id);

  return history
    .map((r) => {
      const ordered = opts.blind
        ? [...r.submissions].sort((a, b) => label(a.teamId).localeCompare(label(b.teamId)))
        : r.submissions;
      const lines = ordered.map((s) => {
        const bits = [
          `${label(s.teamId)} 提交：${renderContent(blueprint.submission.slots, s.content, !!opts.redactSecret)}`,
        ];
        if (s.status === "forfeit") bits.push("（本轮弃权）");
        return `  · ${bits.join(" ")}`;
      });

      const ledger = opts.board ? ledgerLine(r, opts.board, label, !!opts.blind) : null;
      if (ledger) lines.push(`  · 账面：${ledger}`);

      // Participants get the audience-facing summary (team names). The judge gets
      // no prose at all while a board exists: only the settled numbers above count.
      const prose = opts.blind
        ? opts.board || !r.verdict?.verdict
          ? ""
          : `  · 上轮判词：${r.verdict.verdict}`
        : r.verdict
          ? `  · 裁决：${r.verdict.publicSummary || r.verdict.verdict}`
          : "";
      if (prose) lines.push(prose);

      const sudden = r.sudden ? "（加时）" : "";
      return `第 ${r.round} 轮${sudden}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function fmtNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Tell the judge which dimensions the ledger already owns (they are not in the JSON). */
function derivedNote(dimensions: RubricDimension[]): string {
  const derived = dimensions.filter((d) => d.derive);
  if (!derived.length) return "";
  return `${derived
    .map((d) => `\`${d.key}\`「${d.label}」`)
    .join(" / ")} 由引擎按规则结算，不要写；写多了会被覆盖。`;
}

/** One round's reading, keyed by whoever the caller is allowed to see. */
function ledgerLine(
  record: RoundRecord,
  board: BoardSpec,
  label: (teamId: string) => string,
  byLetter: boolean,
): string | null {
  const rank = (teamId: string) => label(teamId);
  const sides = record.settlement?.sides
    ? (byLetter ? [...record.settlement.sides].sort((a, b) => rank(a.teamId).localeCompare(rank(b.teamId))) : record.settlement.sides)
    : null;
  if (sides?.length) {
    return sides
      .map((side) => {
        const values = board.meters
          .map((m) => `${m.label} ${fmtNumber(side.state[m.key] ?? 0)}`)
          .join("、");
        return `${label(side.teamId)} ${side.move ?? "弃权"}（${values}）`;
      })
      .join(" / ");
  }
  // Legacy round: the judge wrote the numbers, so show them (re-lettered).
  const withState = (record.verdict?.scores ?? []).filter((line) => line.state);
  if (!withState.length) return null;
  const ordered = byLetter ? [...withState].sort((a, b) => rank(a.teamId).localeCompare(rank(b.teamId))) : withState;
  return ordered
    .map((line) => {
      const values = board.meters
        .map((m) => `${m.label} ${fmtNumber(line.state?.[m.key] ?? 0)}`)
        .join("、");
      return `${label(line.teamId)}（${values}）`;
    })
    .join(" / ");
}

/* ── board read-out (display only; the engine never interprets it) ── */

function judgeBoardContract(board: BoardSpec | undefined, letters: string[]): string {
  if (!board) return "";
  const lines = [
    "",
    `## 战况读数（必须给）`,
    board.settle
      ? `本局的账由引擎按规则结算完毕，数字已定。\`state\` 必须原样抄回下面「本轮账面」里每方的「结算后」，**不要自己加减**；不一致的读数会被引擎覆盖并留痕。`
      : `\`state\` 写每方**本轮结束后的绝对值**，不是变化量；key 只能是上面声明的这几个，每轮都给全。`,
    board.meters
      .map((m) => `- \`${m.key}\`「${m.label}」：${m.min}–${m.max}${m.threshold != null ? `，临界线 ${m.threshold}` : ""}`)
      .join("\n"),
  ];
  if (board.marks) {
    lines.push(
      `\`marks\` 写当前仍在的「${board.marks.label}」格子编号（升序、最多 16 个），没有就 []；已经引爆/失效的不要写。`,
    );
  }
  return lines.join("\n");
}

/** The same numbers, handed to the players as plain text (they are public anyway). */
function participantBoardReadout(bp: Blueprint, state: MatchState): string {
  if (!bp.board) return "";
  const board = bp.board;
  const last = [...state.history].reverse().find((r) => r.settlement?.sides?.length || r.verdict?.scores?.some((s) => s.state));
  if (!last) return "";

  // The ledger is keyed by team id, so this read-out cannot inherit last round's letters.
  const valuesOf = (teamId: string): Record<string, number> | null => {
    const side = last.settlement?.sides?.find((s) => s.teamId === teamId);
    if (side) return side.state;
    return last.verdict?.scores?.find((s) => s.teamId === teamId)?.state ?? null;
  };

  const rows = board.meters
    .map((meter) => {
      const parts = state.teams.map((team) => {
        const value = valuesOf(team.id)?.[meter.key];
        return `${team.name} ${typeof value === "number" ? fmtNumber(value) : "—"}`;
      });
      return `- ${meter.label}：${parts.join(" / ")}`;
    })
    .join("\n");

  const moves = last.settlement?.sides?.length
    ? `\n上一轮出手：${last.settlement.sides
        .map((s) => `${state.teams.find((t) => t.id === s.teamId)?.name ?? "某方"} ${s.move ?? "弃权"}`)
        .join("、")}`
    : "";

  return `## 战况读数（第 ${last.round} 轮结束时）\n${rows}${moves}`;
}

/* ── participant ───────────────────────────────────────────────────── */

export function buildParticipantPrompt(input: {
  blueprint: Blueprint;
  state: MatchState;
  participant: ParticipantState;
  interventions: Array<{ kind: string; text?: string }>;
  /** Global template overrides; omitted means the built-in wording. */
  templates?: PromptOverrides;
}): PromptBundle {
  const { blueprint: bp, state, participant } = input;
  const team = state.teams.find((t) => t.id === participant.teamId);
  const mates = state.participants.filter(
    (p) => p.teamId === participant.teamId && p.id !== participant.id,
  );
  const ranked = [...state.teams].sort((a, b) => b.totalScore - a.totalScore);
  const myRank = ranked.findIndex((t) => t.id === participant.teamId) + 1;

  const scene = `「${bp.name}」${bp.tagline ? `—— ${bp.tagline}` : ""}`;
  const matesLine = mates.length
    ? `队内 ${mates.length + 1} 人（你，以及座位 ${mates.map((m) => m.seat).join("、")}）。`
    : `队内 1 人。`;
  const submitShape = `{${bp.submission.slots
    .map((s) => `"${s.key}":${s.type === "number" ? "0" : '"..."'}`)
    .join(",")}}`;

  const system = withGlobalAddendum(
    renderPromptTemplate(
      resolvePromptBody("participant.system", input.templates?.["participant.system"]),
      {
        scene,
        briefing: bp.briefing.trim(),
        team: `「${team?.name ?? "本方"}」`,
        mates: matesLine,
        submitShape,
      },
    ),
    input.templates,
  );

  const opponentLines = state.teams
    .filter((t) => t.id !== participant.teamId)
    .map((t) => {
      const members = state.participants.filter((p) => p.teamId === t.id);
      return `- 「${t.name}」（${members.length} 人）累计 ${t.totalScore.toFixed(2)}`;
    })
    .join("\n");

  const history = renderHistory(bp, state.history, {
    anonymise: (teamId) => state.teams.find((t) => t.id === teamId)?.name ?? "某方",
    redactSecret: true,
    board: bp.board,
  });

  const dm = input.interventions.filter((i) => i.kind === "say" || i.kind === "rule");
  const dmBlock = dm.length
    ? `\n## 场外干预（必须服从）\n${dm.map((d) => (d.kind === "rule" ? `新规则：${d.text}` : `有人在罐外说：${d.text}`)).join("\n")}\n`
    : "";

  const sudden = state.suddenDeath
    ? `\n**这是加时轮：本轮由裁判直接判谁更强，不再打 rubric 分。**\n`
    : "";

  // 已公布的战况只增不改，放最前；轮次、积分、本轮要求都会变，全部排在它之后。
  // 这样同一个座位下一轮的开头与这一轮逐字节相同，前缀缓存才有东西可命中。
  const historyBlock = [`## 已公布的战况`, history].join("\n");

  const live = [
    participantBoardReadout(bp, state),
    `## 积分`,
    `你方「${team?.name ?? ""}」累计 ${team?.totalScore.toFixed(2) ?? "0.00"}，目前排第 ${myRank} / ${ranked.length}。`,
    opponentLines || "",
    `现在是第 ${state.round} / ${bp.rounds} 轮。${sudden}`,
    `## 本轮你要提交`,
    bp.submission.slots.map(slotLine).join("\n"),
    dmBlock,
    `现在提交。先想，再交。`,
  ]
    .filter(Boolean)
    .join("\n");

  const user = `${historyBlock}\n\n${live}`;
  return { system, messages: [{ role: "user", content: user, cacheAt: historyBlock.length }] };
}

/* ── judge ─────────────────────────────────────────────────────────── */

export function buildJudgePrompt(input: {
  blueprint: Blueprint;
  state: MatchState;
  blindMap: Record<string, string>;
  sudden: boolean;
  /** Engine-settled ledger for this round; null/absent = the judge keeps the books. */
  settlement?: Settlement | null;
  /** Global template overrides; omitted means the built-in wording. */
  templates?: PromptOverrides;
}): PromptBundle {
  const { blueprint: bp, state, blindMap, sudden } = input;
  const settlement = input.settlement ?? null;
  const letterOf = (teamId: string) => Object.entries(blindMap).find(([, id]) => id === teamId)?.[0] ?? "?";
  const letters = Object.keys(blindMap).sort();
  const teamOf = (letter: string) => state.teams.find((t) => t.id === blindMap[letter]);

  const board = bp.board;
  // Dimensions the engine derives are not asked for: one less number to copy wrong.
  const judgeDims = bp.rubric.dimensions.filter((d) => !d.derive);
  const scoreShape = Object.fromEntries([
    ...judgeDims.map((d) => [d.key, 0] as const),
    ["notes", "一句话点评"] as const,
  ]);
  const formatShape: Record<string, unknown> = {
    scores: Object.fromEntries(letters.map((l) => [l, scoreShape])),
  };
  if (board) {
    formatShape.state = Object.fromEntries(
      letters.map((l) => [l, Object.fromEntries(board.meters.map((m) => [m.key, 0]))]),
    );
  }
  if (board?.marks) formatShape.marks = [];
  formatShape.verdict = "一句话判词";
  formatShape.publicSummary = "一句话战况";

  const letterNote = [
    `## 字母`,
    `${letters.join(" / ")} 每轮重新分配；本 prompt 里出现的所有字母都已按**本轮**改写，历史不由你换算。`,
    settlement ? `本轮的数字以「本轮账面」为准，那是引擎按规则结算的结果。` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const format = sudden
    ? [
        letterNote,
        `## 这是加时轮`,
        `不再打 rubric 分，直接判这一轮谁更强。`,
        `## 输出格式（严格 JSON，不要代码围栏）`,
        `{"winner":"A","verdict":"一句话判词","publicSummary":"一句话战况"}`,
      ].join("\n")
    : [
        letterNote,
        `## 输出格式（严格 JSON，不要代码围栏，不要解释）`,
        JSON.stringify(formatShape),
        derivedNote(bp.rubric.dimensions),
        judgeBoardContract(board, letters),
      ]
        .filter(Boolean)
        .join("\n\n");

  const system = withGlobalAddendum(
    renderPromptTemplate(resolvePromptBody("judge.system", input.templates?.["judge.system"]), {
      match: bp.name,
      letters: letters.join(" / "),
      briefing: bp.briefing.trim(),
      judgeBrief: bp.judgeBrief?.trim() ? `\n## 裁判补充说明\n${bp.judgeBrief.trim()}\n` : "",
      rubric: bp.rubric.dimensions.map((d) => `- \`${d.key}\`「${d.label}」：${d.hint}`).join("\n"),
      weights: bp.rubric.dimensions.map((d) => `${d.label} ${Math.round(d.weight * 100)}%`).join("，"),
      format,
    }),
    input.templates,
  );

  const currentLines = letters
    .map((letter) => {
      const team = teamOf(letter);
      if (!team) return "";
      const subs = state.participants.filter((p) => p.teamId === team.id);
      const body = subs
        .map((p) => {
          const sub = state.pending[p.id];
          if (!sub || sub.status === "forfeit") return `    （弃权）`;
          return `    ${renderContent(bp.submission.slots, sub.content, false)}`;
        })
        .join("\n");
      return `${letter} 方：\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const ledgerBlock = settlement
    ? [
        `## 本轮账面（引擎已结算，照抄 state）`,
        ...[...settlement.sides]
          .sort((a, b) => letterOf(a.teamId).localeCompare(letterOf(b.teamId)))
          .map((side) => {
            const letter = letterOf(side.teamId);
            const deltas = board
              ? board.meters
                  .map((m) => `${m.label} ${side.delta[m.key] ? (side.delta[m.key] > 0 ? "+" : "") + side.delta[m.key] : "0"}`)
                  .join("、")
              : "";
            const after = board
              ? board.meters.map((m) => `${m.label} ${fmtNumber(side.state[m.key] ?? 0)}`).join("、")
              : "";
            const move = side.move ?? `弃权记${settlement.forfeit}`;
            return `- ${letter}：出「${move}」；本轮 ${deltas}；结算后 ${after}`;
          }),
      ].join("\n")
    : "";

  const history = renderHistory(bp, state.history, {
    anonymise: (id) => letterOf(id),
    board,
    blind: true,
  });

  const user = [
    `第 ${state.round} / ${bp.rounds} 轮，以下是本轮所有方的提交。`,
    `## 本轮提交\n${currentLines}`,
    ledgerBlock,
    history === "（还没有开打。）" ? "" : `## 前几轮（已公布）\n${history}`,
    `出招顺序无关，谁先提交不构成优劣。只依据上面这些事实判分。`,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

  return { system, messages: [{ role: "user", content: user }] };
}

/** The old protocol marker for reference; submissions use <<<SUBMIT>>>. */
export const SUBMIT_MARKER = "<<<SUBMIT>>>";
