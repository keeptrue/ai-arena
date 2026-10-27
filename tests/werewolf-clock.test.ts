import { describe, expect, test } from "bun:test";
import { parseWerewolfBlueprint } from "../src/engine/werewolf/blueprint";
import { buildSeatPrompt, renderPublicLogSections, speechClock } from "../src/engine/werewolf/prompt";
import { createWerewolfState } from "../src/engine/werewolf/reduce";
import type { PublicEntry, WerewolfPhase, WerewolfState } from "../src/engine/werewolf/types";

const BASE = {
  mode: "werewolf",
  id: "ww-clock",
  name: "预女猎九人局",
  tagline: "测试",
  seats: 9,
  briefing: "九人局测试规则正文，足够长，用来满足校验。三狼三民预女猎，无警长，屠边获胜。",
  roles: [
    { id: "wolf", label: "狼人", camp: "wolf", count: 3 },
    { id: "villager", label: "村民", camp: "good", count: 3 },
    { id: "seer", label: "预言家", camp: "good", count: 1 },
    { id: "witch", label: "女巫", camp: "good", count: 1 },
    { id: "hunter", label: "猎人", camp: "good", count: 1 },
  ],
};

const SPEC = parseWerewolfBlueprint(BASE);
const ROLES = ["wolf", "wolf", "wolf", "villager", "villager", "villager", "seer", "witch", "hunter"] as const;

const DAWN: PublicEntry = { kind: "dawn", day: 2, deaths: [5] };

function build(input: {
  phase?: WerewolfPhase;
  queue?: number[];
  queueIndex?: number;
  pk?: WerewolfState["pk"];
  log?: PublicEntry[];
} = {}): WerewolfState {
  const state = createWerewolfState({
    matchId: "m-clock",
    spec: SPEC,
    seed: "seed",
    dealSource: "manual",
    seats: ROLES.map((role, seat) => ({ participantId: `p${seat}`, seat, role })),
    budget: { maxCalls: 100, maxTokens: 0 },
    at: 0,
  });
  state.day = 2;
  state.phase = input.phase ?? "day_speech";
  state.queue = input.queue ?? [2, 3, 4, 8, 0, 1];
  state.queueIndex = input.queueIndex ?? 3;
  state.pk = input.pk ?? null;
  state.lastSpeaker = 3;
  state.publicLog = input.log ?? [
    DAWN,
    { kind: "speech", day: 2, seat: 2, text: "2号说过的话" },
    { kind: "speech", day: 2, seat: 3, text: "3号说过的话" },
    { kind: "speech", day: 1, seat: 8, text: "昨天的老发言" },
  ];
  return state;
}

function userOf(state: WerewolfState, seat: number): string {
  return buildSeatPrompt({ state, seat }).messages[0].content;
}

describe("speech clock", () => {
  test("a mid-order speaker knows its slot, who spoke, and who is still waiting", () => {
    const clock = speechClock(build(), 4)!;
    expect(clock.order).toEqual([2, 3, 4, 8, 0, 1]);
    expect(clock.position).toBe(3);
    expect(clock.spoken).toEqual([2, 3]);
    expect(clock.upcoming).toEqual([8, 0, 1]);
    expect(clock.silent).toEqual([]);
  });

  test("the prompt states the order instead of leaving it to be guessed", () => {
    const user = userOf(build(), 4);
    expect(user).toContain("你是本轮第 3 位发言（共 6 人）");
    expect(user).toContain("发言顺序：3号 → 4号 → 5号 → 9号 → 1号 → 2号");
    expect(user).toContain("已经说完：3号、4号");
    expect(user).toContain("还没轮到：9号、1号、2号（他们此刻一个字都没说，且都会在本轮开口）");
  });

  test("the first speaker is told there is nothing behind him yet", () => {
    const state = build({ queue: [2, 3, 4, 8, 0, 1], queueIndex: 1, log: [DAWN] });
    const user = userOf(state, 2);
    expect(user).toContain("你是本轮第一个开口的人");
    expect(user).toContain("已经说完：无");
    expect(user).toContain("还没轮到：4号、5号、9号、1号、2号");
  });

  test("a recalled seat's earlier 过麦 line is not a speech", () => {
    const state = build({
      queue: [2, 3, 4],
      queueIndex: 2,
      log: [
        DAWN,
        { kind: "speech", day: 2, seat: 2, text: "2号说过的话" },
        { kind: "speech", day: 2, seat: 3, text: "（过麦）" },
      ],
    });
    state.recalled = [3];
    const clock = speechClock(state, 3)!;
    expect(clock.spoken).toEqual([2]);
    expect(clock.position).toBe(2);
    expect(clock.upcoming).toEqual([4]);
  });

  test("the PK clock only lists the candidates", () => {
    const state = build({
      phase: "day_pk_speech",
      pk: { candidates: [4, 8], votes: {} },
      queue: [4, 8],
      queueIndex: 2,
      log: [
        DAWN,
        { kind: "speech", day: 2, seat: 4, text: "PK 台上先说", pk: true },
      ],
    });
    const clock = speechClock(state, 8)!;
    expect(clock.order).toEqual([4, 8]);
    expect(clock.position).toBe(2);
    expect(clock.spoken).toEqual([4]);
    expect(clock.upcoming).toEqual([]);

    const user = userOf(state, 8);
    expect(user).toContain("平票进 PK：5号、9号");
    expect(user).toContain("发言顺序：5号 → 9号");
    expect(user).toContain("已经说完：5号");
  });

  test("the vote clock reports the real speaking order and the silent seats", () => {
    const log: PublicEntry[] = [{ kind: "dawn", day: 2, deaths: [5] }];
    for (const seat of [2, 3, 4, 8, 0, 1]) {
      log.push({ kind: "speech", day: 2, seat, text: `${seat + 1}号发言` });
    }
    const state = build({ phase: "day_vote", queue: [2, 3, 4, 8, 0, 1], queueIndex: 6, log });
    state.seats.find((s) => s.seat === 5)!.alive = false;

    const clock = speechClock(state, 4)!;
    expect(clock.position).toBeNull();
    expect(clock.order).toEqual([2, 3, 4, 8, 0, 1]);
    expect(clock.silent).toEqual([6, 7]);

    const user = userOf(state, 4);
    expect(user).toContain("本轮发言已结束：6 人说完");
    expect(user).toContain("没有开口：7号、8号");
  });

  test("an alive seat that never spoke shows up at vote time", () => {
    const log: PublicEntry[] = [
      { kind: "dawn", day: 2, deaths: [5] },
      { kind: "speech", day: 2, seat: 2, text: "2号发言" },
      { kind: "speech", day: 2, seat: 3, text: "3号发言" },
    ];
    const state = build({ phase: "day_vote", queue: [2, 3, 4, 8, 0, 1], queueIndex: 6, log });
    state.seats.find((s) => s.seat === 5)!.alive = false;
    state.seats.find((s) => s.seat === 6)!.afk = true;

    expect(speechClock(state, 4)!.silent).toEqual([0, 1, 4, 6, 7, 8]);
    expect(userOf(state, 4)).toContain("没有开口：1号、2号、5号、7号、8号、9号");
  });

  test("night phases carry no clock", () => {
    expect(speechClock(build({ phase: "night_wolves" }), 0)).toBeNull();
    expect(speechClock(build({ phase: "day_last_words" }), 0)).toBeNull();
  });
});

describe("speech discipline", () => {
  test("only speaking phases warn against the turn-order fallacy", () => {
    const speaking = userOf(build(), 4);
    expect(speaking).toContain("## 发言纪律");
    expect(speaking).toContain("「后面的人还没发言，所以他们有问题」");
    expect(speaking).toContain("还没轮到他");

    const night = userOf(build({ phase: "night_wolves" }), 0);
    expect(night).not.toContain("## 发言纪律");
  });

  test("the clock never carries roles or night actions", () => {
    const user = userOf(build(), 0);
    const clock = user.slice(user.indexOf("## 牌桌时序"), user.indexOf("## 本轮可选目标"));
    expect(clock).toContain("发言顺序");
    expect(clock).not.toContain("狼队友");
    expect(clock).not.toContain("查验记录");
    expect(clock).not.toContain("药剂");
  });

  test("the default speech limit is 800 characters", () => {
    const user = userOf(build(), 4);
    expect(user).toContain("发言不超过 800 字");
  });
});

describe("public chronicle", () => {
  test("today keeps the end of a long speech", () => {
    const long = `${"甲".repeat(1100)}结论：我投7号`;
    const state = build({
      log: [DAWN, { kind: "speech", day: 2, seat: 2, text: long }],
    });
    const sections = renderPublicLogSections(state);
    expect(sections.today.length).toBeLessThan(long.length);
    expect(sections.today).toContain("结论：我投7号");
  });

  test("older days keep their tail too", () => {
    const old = `${"乙".repeat(900)}昨天的结论：我站2号`;
    const state = build({
      log: [{ kind: "speech", day: 1, seat: 7, text: old }, DAWN],
    });
    const sections = renderPublicLogSections(state);
    expect(sections.history).toContain("昨天的结论：我站2号");
    expect(sections.today).not.toContain("昨天的结论");
  });

  test("a long history never truncates today's block", () => {
    const log: PublicEntry[] = [];
    for (let i = 0; i < 40; i += 1) {
      log.push({ kind: "speech", day: 1, seat: i % 9, text: `${"丙".repeat(300)}旧${i}` });
    }
    for (let seat = 0; seat < 9; seat += 1) {
      log.push({ kind: "speech", day: 2, seat, text: `${"丁".repeat(500)}今天${seat + 1}号` });
    }
    const state = build({ log });
    const sections = renderPublicLogSections(state);
    for (let seat = 0; seat < 9; seat += 1) {
      expect(sections.today).toContain(`今天${seat + 1}号`);
    }
    expect(sections.history).toContain("更早的发言已省略");
  });

  test("old votes and deaths survive even when old speeches are dropped", () => {
    const log: PublicEntry[] = [{ kind: "vote", day: 1, counts: { 2: 5 }, exiled: 2, tie: [] }];
    for (let i = 0; i < 40; i += 1) {
      log.push({ kind: "speech", day: 1, seat: i % 9, text: `${"丙".repeat(300)}旧${i}` });
    }
    log.push({ kind: "speech", day: 2, seat: 0, text: "今天的发言" });
    const sections = renderPublicLogSections(build({ log }));
    expect(sections.history).toContain("第1天 投票：3号5票；3号被放逐");
    expect(sections.history).toContain("更早的发言已省略，票型与死讯保留");
  });

  test("an empty day and an empty history are both explicit", () => {
    const state = build({ log: [] });
    const sections = renderPublicLogSections(state);
    expect(sections.today).toBe("（今天还没有人发言。）");
    expect(sections.history).toBe("（没有更早的记录。）");
  });
});
