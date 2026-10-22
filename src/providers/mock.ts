/**
 * Local rehearsal provider.
 *
 * Zero keys, deterministic-ish, streams like a real model. It reads the same prompts
 * a real model would, so the whole arena is playable and testable before any
 * credentials exist.
 */

import { fnv1a, mulberry32 } from "@/engine/rng";
import type { CallRequest, CallResult, DeltaSink, ProviderAdapter } from "./types";

const OPENERS = [
  "先看它上一轮漏了什么。",
  "这个局面不能先亮底牌。",
  "它刚才那句话太满了，留了缝。",
  "我手里的余量比它想的多。",
  "再退就退到底了，这一手得压上去。",
];

const LINES = [
  "这话我说到这儿，剩下的你们自己算。",
  "我不急，急的是对面。",
  "先别急着点头，听我把条件说完。",
  "这个价，你觉得我是在让利？",
  "我记性好，上一轮的话我都留着。",
  "再撑一轮，它就要松口。",
];

const CHOICE_WORDS = ["温和", "强硬", "观望", "合作", "背叛", "加注", "退出"];

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick<T>(arr: T[], h: number): T {
  return arr[(h >>> 0) % arr.length];
}

interface SlotDef {
  key: string;
  label: string;
  type: "text" | "number" | "choice";
  choices?: string[];
}

/** Reads the board ranges out of the judge's 战况读数 block (empty when the rules declare none). */
function parseBoardMeters(system: string): Array<{ key: string; min: number; max: number }> {
  const meters: Array<{ key: string; min: number; max: number }> = [];
  for (const m of system.matchAll(/- `([a-z0-9_]+)`「[^」]+」：(-?\d+)–(-?\d+)/g)) {
    meters.push({ key: m[1], min: Number(m[2]), max: Number(m[3]) });
  }
  return meters;
}

/** Parses the slot list out of the participant system prompt. */
function parseSlots(system: string): SlotDef[] {
  const slots: SlotDef[] = [];
  for (const m of system.matchAll(/- `([a-z0-9_]+)`「([^」]+)」[^文数选\n]{0,12}(文本|数字|选项)([^\n]*)/g)) {
    const key = m[1];
    const label = m[2];
    const rawType = m[3];
    const tail = m[4] ?? "";
    const type = rawType === "数字" ? "number" : rawType === "选项" ? "choice" : "text";
    const choices = tail.includes("取值") ? tail.split("取值")[1].split(/[\n·]/)[0].split("/").map((s) => s.trim()).filter(Boolean) : undefined;
    slots.push({ key, label, type, choices });
  }
  return slots;
}

export const mock: ProviderAdapter = {
  kind: "mock",
  async call(req: CallRequest, onDelta: DeltaSink): Promise<CallResult> {
    const started = Date.now();
    const system = req.system;
    const user = req.messages[req.messages.length - 1]?.content ?? "";
    const promptTokens = Math.ceil((system.length + user.length) / 2.6);
    const h = fnv1a(`${user.slice(-300)}|${system.slice(0, 200)}`);

    /* ── compiler branch ── */
    if (system.includes("对局规则的编译器")) {
      const title = (user.match(/^#\s*(.+)$/m) ?? [, "未命名对局"])[1].trim();
      const roundsMatch = user.match(/(\d+)\s*轮/);
      const rounds = Math.min(20, Math.max(2, roundsMatch ? Number(roundsMatch[1]) : 5));
      const isAuction = /报价|出价|竞标|价格/.test(user);
      const body = JSON.stringify({
        id: `rule-${(fnv1a(user.slice(0, 200)) >>> 0).toString(36)}`,
        name: title.slice(0, 20),
        tagline: "由演练场编译，仅供流程验证",
        rounds,
        briefing: user.slice(0, 1200),
        submission: {
          slots: isAuction
            ? [
                { key: "bid", label: "报价", type: "number", required: true, reveal: "secret", hint: "只有裁判看得到" },
                { key: "statement", label: "公开陈述", type: "text", required: true, reveal: "public", hint: "当场说给所有人" },
              ]
            : [
                { key: "action", label: "行动", type: "text", required: true, reveal: "public", hint: "本轮你要做的事" },
                { key: "note", label: "底牌", type: "text", required: false, reveal: "secret", hint: "只有裁判看得到" },
              ],
        },
        rubric: {
          dimensions: [
            { key: "calculation", label: "算计", weight: 0.4, hint: "是否算清了代价与收益" },
            { key: "execution", label: "执行", weight: 0.35, hint: "说的和做的是否一致" },
            { key: "presence", label: "表现", weight: 0.25, hint: "是否形成了让人记住的形象" },
          ],
        },
        victory: { type: "rubric_total", tiebreaker: "sudden_death", tieThreshold: 0.5 },
      });
      for (const chunk of body.match(/[\s\S]{1,24}/g) ?? []) {
        onDelta({ text: chunk });
        await wait(10);
      }
      return {
        text: body,
        thinking: "",
        usage: { promptTokens, completionTokens: Math.ceil(body.length / 2.6) },
        latencyMs: Date.now() - started,
      };
    }

    /* ── judge branch ── */
    if (system.includes("## 评分维度")) {
      const sudden = system.includes("这是加时轮");
      const letters = [...user.matchAll(/(?:^|\n)([A-H]) 方：/g)].map((m) => m[1]);
      const keys = [...system.matchAll(/- `([a-z0-9_]+)`「[^」]+」/g)].map((m) => m[1]);
      const uniqKeys = [...new Set(keys)];
      const rnd = mulberry32(fnv1a(user.slice(0, 500)));

      let body: string;
      if (sudden) {
        const winner = letters.length ? letters[Math.floor(rnd() * letters.length)] : "A";
        body = JSON.stringify({
          winner,
          verdict: `${winner} 方这一轮更沉得住气。`,
          publicSummary: `加时轮，${winner} 方把话说到点上。`,
        });
      } else {
        const sides = letters.length ? letters : ["A", "B"];
        const scores: Record<string, Record<string, number | string>> = {};
        for (const letter of sides) {
          scores[letter] = {};
          for (const k of uniqKeys) scores[letter][k] = Math.round((5 + rnd() * 4.5) * 10) / 10;
          scores[letter].notes = rnd() > 0.5 ? "算到了下一轮的交换比。" : "话说得漂亮，代价没算清。";
        }

        // The rehearsal judge also echoes a board reading when the rules declare one,
        // so the whole panel can be exercised without a model key.
        const meters = parseBoardMeters(system);
        const roundNo = Number(user.match(/第 (\d+) \/ \d+ 轮/)?.[1] ?? 1);
        const state: Record<string, Record<string, number>> = {};
        for (const letter of sides) {
          state[letter] = {};
          for (const meter of meters) {
            const walk = mulberry32(fnv1a(`${letter}|${meter.key}|${roundNo}`));
            const span = meter.max - meter.min;
            state[letter][meter.key] = Math.round(meter.min + span * (0.15 + 0.7 * walk()));
          }
        }
        const draft: Record<string, unknown> = { scores, verdict: "分差不大，但有人更清楚自己在做什么。", publicSummary: "本轮结束，双方都亮了底。" };
        if (meters.length) draft.state = state;
        if (meters.length && system.includes('"marks":[]')) {
          const widest = meters.reduce((a, b) => (b.max - b.min > a.max - a.min ? b : a), meters[0]);
          const marks = Array.from(new Set([
            Math.round(widest.min + (widest.max - widest.min) * 0.25),
            Math.round(widest.min + (widest.max - widest.min) * 0.6),
          ])).sort((a, b) => a - b);
          draft.marks = marks;
        }
        // Keep the documented key order readable for anyone reading the raw JSON.
        body = JSON.stringify({
          scores,
          ...(draft.state ? { state: draft.state } : {}),
          ...(draft.marks ? { marks: draft.marks } : {}),
          verdict: draft.verdict,
          publicSummary: draft.publicSummary,
        });
      }

      for (const chunk of body.match(/[\s\S]{1,24}/g) ?? []) {
        onDelta({ text: chunk });
        await wait(14);
      }
      return {
        text: body,
        thinking: "",
        usage: { promptTokens, completionTokens: Math.ceil(body.length / 2.6) },
        latencyMs: Date.now() - started,
      };
    }

    /* ── participant branch ── */
    const side = (system.match(/你属于「(.+?)」/) ?? [, "本方"])[1];
    // Slot definitions live in the user turn; the system turn only sketches the JSON shape.
    const slots = parseSlots(`${system}\n${user}`);
    const roundMatch = user.match(/第 (\d+) \/ (\d+) 轮/);
    const round = roundMatch ? Number(roundMatch[1]) : 1;

    const content: Record<string, unknown> = {};
    for (const slot of slots) {
      const local = fnv1a(`${h}|${slot.key}|${round}`);
      if (slot.type === "number") {
        content[slot.key] = 100 + (local % 900);
      } else if (slot.type === "choice") {
        content[slot.key] = slot.choices?.length ? slot.choices[local % slot.choices.length] : pick(CHOICE_WORDS, local);
      } else {
        content[slot.key] = `${pick(LINES, local)}`;
      }
    }
    if (slots.length === 0) content.move = "观望";

    const thinking = `${pick(OPENERS, h)}（${side} 第 ${round} 轮：${
      Object.entries(content)
        .map(([k, v]) => `${k}=${v}`)
        .join("，") || "无槽位"
    }）`;
    const script = `<<<THINK>>>\n${thinking}\n<<<SUBMIT>>>\n${JSON.stringify(content)}`;

    let text = "";
    for (const chunk of script.match(/[\s\S]{1,18}/g) ?? []) {
      text += chunk;
      onDelta({ text: chunk });
      await wait(40);
    }

    return {
      text,
      thinking: "",
      usage: { promptTokens, completionTokens: Math.ceil(text.length / 2.6) },
      latencyMs: Date.now() - started,
    };
  },
};
