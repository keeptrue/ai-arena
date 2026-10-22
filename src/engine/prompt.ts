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
} from "./types";

export interface PromptBundle {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
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
  } = {},
): string {
  if (history.length === 0) return "（还没有开打。）";
  const label = opts.anonymise ?? ((id: string) => id);
  const teamName = (id: string) => label(id);

  return history
    .map((r) => {
      const lines = r.submissions.map((s) => {
        const bits = [
          `${teamName(s.teamId)} 提交：${renderContent(blueprint.submission.slots, s.content, !!opts.redactSecret)}`,
        ];
        if (s.status === "forfeit") bits.push("（本轮弃权）");
        return `  · ${bits.join(" ")}`;
      });
      const verdict = r.verdict ? `  · 裁决：${r.verdict.publicSummary || r.verdict.verdict}` : "";
      const sudden = r.sudden ? "（加时）" : "";
      return `第 ${r.round} 轮${sudden}\n${lines.join("\n")}${verdict ? `\n${verdict}` : ""}`;
    })
    .join("\n\n");
}

/* ── board read-out (display only; the engine never interprets it) ── */

function judgeBoardContract(board: BoardSpec | undefined, letters: string[]): string {
  if (!board) return "";
  const lines = [
    "",
    `## 战况读数（必须给）`,
    `\`state\` 写每方**本轮结束后的绝对值**，不是变化量；key 只能是上面声明的这几个，每轮都给全。`,
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
  const last = [...state.history].reverse().find((r) => r.verdict?.scores?.some((s) => s.state));
  if (!last?.verdict) return "";
  const rows = bp.board.meters
    .map((meter) => {
      const parts = state.teams.map((team) => {
        const line = last.verdict!.scores.find((s) => s.teamId === team.id);
        const value = line?.state?.[meter.key];
        return `${team.name} ${typeof value === "number" ? value : "—"}`;
      });
      return `- ${meter.label}：${parts.join(" / ")}`;
    })
    .join("\n");
  return `## 战况读数（第 ${last.round} 轮结束时）\n${rows}`;
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
  });

  const dm = input.interventions.filter((i) => i.kind === "say" || i.kind === "rule");
  const dmBlock = dm.length
    ? `\n## 场外干预（必须服从）\n${dm.map((d) => (d.kind === "rule" ? `新规则：${d.text}` : `有人在罐外说：${d.text}`)).join("\n")}\n`
    : "";

  const sudden = state.suddenDeath
    ? `\n**这是加时轮：本轮由裁判直接判谁更强，不再打 rubric 分。**\n`
    : "";

  const user = [
    `现在是第 ${state.round} / ${bp.rounds} 轮。${sudden}`,
    "",
    `## 积分`,
    `你方「${team?.name ?? ""}」累计 ${team?.totalScore.toFixed(2) ?? "0.00"}，目前排第 ${myRank} / ${ranked.length}。`,
    opponentLines || "",
    "",
    `## 已公布的战况`,
    history,
    "",
    participantBoardReadout(bp, state),
    "",
    `## 本轮你要提交`,
    bp.submission.slots.map(slotLine).join("\n"),
    "",
    dmBlock,
    `现在提交。先想，再交。`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, messages: [{ role: "user", content: user }] };
}

/* ── judge ─────────────────────────────────────────────────────────── */

export function buildJudgePrompt(input: {
  blueprint: Blueprint;
  state: MatchState;
  blindMap: Record<string, string>;
  sudden: boolean;
  /** Global template overrides; omitted means the built-in wording. */
  templates?: PromptOverrides;
}): PromptBundle {
  const { blueprint: bp, state, blindMap, sudden } = input;
  const letterOf = (teamId: string) => Object.entries(blindMap).find(([, id]) => id === teamId)?.[0] ?? "?";
  const letters = Object.keys(blindMap).sort();
  const teamOf = (letter: string) => state.teams.find((t) => t.id === blindMap[letter]);

  const board = bp.board;
  const stateShape = board
    ? letters
        .map((l) => `"${l}":{${board.meters.map((m) => `"${m.key}":0`).join(",")}}`)
        .join(",")
    : "";
  const format = sudden
    ? [
        `## 这是加时轮`,
        `不再打 rubric 分，直接判这一轮谁更强。`,
        `## 输出格式（严格 JSON，不要代码围栏）`,
        `{"winner":"A","verdict":"一句话判词","publicSummary":"一句话战况"}`,
      ].join("\n")
    : [
        `## 输出格式（严格 JSON，不要代码围栏，不要解释）`,
        `{"scores":{${letters.map((l) => `"${l}":{"${bp.rubric.dimensions.map((d) => d.key).join('":0,"')}":0,"notes":"一句话点评"}`).join(",")}}${board ? `,"state":{${stateShape}}` : ""}${board?.marks ? ',"marks":[]' : ""},"verdict":"一句话判词","publicSummary":"一句话战况"}`,
        judgeBoardContract(board, letters),
      ].join("\n");

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

  const history = renderHistory(bp, state.history, { anonymise: (id) => letterOf(id) });

  const user = [
    `第 ${state.round} / ${bp.rounds} 轮，以下是本轮所有方的提交。`,
    "",
    `## 本轮提交`,
    currentLines,
    "",
    history === "（还没有开打。）" ? "" : `## 前几轮（已公布）\n${history}`,
    "",
    `出招顺序无关，谁先提交不构成优劣。只依据上面这些事实判分。`,
  ]
    .filter(Boolean)
    .join("\n");

  return { system, messages: [{ role: "user", content: user }] };
}

/** The old protocol marker for reference; submissions use <<<SUBMIT>>>. */
export const SUBMIT_MARKER = "<<<SUBMIT>>>";
