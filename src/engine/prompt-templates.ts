/**
 * Global prompt templates.
 *
 * Every word the arena says to a model lives here as a plain string with
 * `{{placeholders}}`, so the wording can be edited from /prompts without
 * touching the engine. Dynamic facts stay in code: a template receives values,
 * it never reads match state by itself.
 *
 * The engine stays pure — overrides arrive as an argument, never as a query.
 */

export type PromptKey =
  | "participant.system"
  | "judge.system"
  | "compile.system"
  | "global.addendum";

export interface PromptVariable {
  name: string;
  note: string;
  required: boolean;
}

export interface PromptSlot {
  key: PromptKey;
  label: string;
  group: "选手" | "裁判" | "编译" | "全局";
  description: string;
  variables: PromptVariable[];
  /** Literal markers the protocol needs; dropping them breaks parsing at runtime. */
  requiredTokens: string[];
  defaultBody: string;
}

/** Saved overrides, keyed by template. A missing key means "use the built-in". */
export type PromptOverrides = Partial<Record<PromptKey, string>>;

const PARTICIPANT_SYSTEM = `你在参加一场多方对局。不是助手在回答问题——你是这场对局里的一方，为自己赢。

## 场子
{{scene}}

## 规则（这是唯一的判据，逐条照做）
{{briefing}}

## 你的位置
你属于{{team}}。{{mates}}
你和队友本轮**同时**提交，看不到彼此这一轮写了什么；上一轮的公开内容你们都能看到。
思考是写给观众的一段说明：为什么这么选。对手看不到，裁判也看不到——他只看你提交的内容。

## 输出格式（严格照做，JSON 之后不要再写任何字）
<<<THINK>>>
（说给观众听：你看到了什么、为什么这么选、放弃了什么。**500 字以内**，一段话说完就停；不要复述规则，不要写成推演稿。这段对手与裁判都看不到。）
<<<SUBMIT>>>
{{submitShape}}`;

const JUDGE_SYSTEM = `你是「{{match}}」的裁判。你只看到 {{letters}} 几方，不知道它们是谁，也不要猜。

## 规则
{{briefing}}
{{judgeBrief}}
## 评分维度（每项 0–10 分，可用小数）
{{rubric}}
权重：{{weights}}

## 判分标准
- 6 分是「正常发挥」，8 分要有清楚的算计，10 分只给真正读懂了局面的一手。
- 结果好但过程糊，不给高分；过程漂亮但输了，照样给分。
- 不要因为写得长就给高分。空话扣分。
- 每方读的是它在**本轮**的整体表现（多人队伍合起来读一份）。

{{format}}`;

const COMPILE_SYSTEM = `你是对局规则的编译器。用户会写一段自然语言的对战规则，你要把它编译成严格 JSON。

只输出 JSON，不要代码围栏，不要解释。

## JSON 结构
{
  "id": "kebab-case 英文 id",
  "name": "中文短名，不超过 12 字",
  "tagline": "一句话副标题，不超过 30 字",
  "rounds": 整数 1-{{maxRounds}},
  "briefing": "把用户规则整理成给选手看的完整规则正文（可以扩写、可以结构化，但不能改变原意，也不能新增胜利条件）",
  "submission": {
    "slots": [
      {
        "key": "snake_case 英文键名",
        "label": "中文短标签",
        "type": "text" | "number" | "choice",
        "choices": ["仅 type=choice 时给选项"],
        "required": true,
        "reveal": "public" | "secret",
        "hint": "给选手的填写说明"
      }
    ]
  },
  "rubric": {
    "dimensions": [
      { "key": "snake_case", "label": "中文短标签", "weight": 数字, "hint": "这一维看什么" }
    ]
  },
  "victory": { "type": "rubric_total", "tiebreaker": "sudden_death", "tieThreshold": 0.5 },
  "judgeBrief": "给裁判的额外说明（可选）"
}

## 硬约束
- slots 数量 1-{{maxSlots}}；dimensions 数量 2-{{maxDimensions}}；weight 之和必须等于 1。
- reveal 只有两种：public（本轮结束后所有人可见）和 secret（只有裁判可见）。用户要求「暗标 / 底牌 / 不公开」的，用 secret。
- 引擎不校验动作是否合法，所以不要在 JSON 里写校验逻辑；合法性由裁判在评分时体现。
- 不要把数值结算写进蓝图。如果规则里有算账，写进 briefing 让人和裁判去算。
- 所有中文文本面向人类阅读，不要出现「模型」「AI」「LLM」这类词。`;

export const PROMPT_SLOTS: Record<PromptKey, PromptSlot> = {
  "participant.system": {
    key: "participant.system",
    label: "选手 system",
    group: "选手",
    description: "每位选手开局收到的 system 提示词。动态事实（队名、座位、提交骨架）由引擎填进占位符。",
    variables: [
      { name: "scene", note: "场子标题行：「对局名」—— 副标题", required: true },
      { name: "briefing", note: "蓝图里的规则正文", required: true },
      { name: "team", note: "本方队名，含「」", required: true },
      { name: "mates", note: "队内人数与座位说明整句", required: true },
      { name: "submitShape", note: "提交 JSON 骨架，由槽位生成", required: true },
    ],
    requiredTokens: ["<<<THINK>>>", "<<<SUBMIT>>>"],
    defaultBody: PARTICIPANT_SYSTEM,
  },
  "judge.system": {
    key: "judge.system",
    label: "裁判 system",
    group: "裁判",
    description: "裁判收到的 system 提示词。只要不写入身份信息，盲化就仍然成立。",
    variables: [
      { name: "match", note: "对局名（不带引号）", required: true },
      { name: "letters", note: "盲化字母表，如 A / B", required: true },
      { name: "briefing", note: "蓝图里的规则正文", required: true },
      { name: "judgeBrief", note: "裁判补充说明整段；没有时为空串", required: false },
      { name: "rubric", note: "评分维度清单", required: true },
      { name: "weights", note: "权重行，如「甲 50%，乙 50%」", required: true },
      { name: "format", note: "输出格式整块；普通轮与加时轮不同", required: true },
    ],
    requiredTokens: [],
    defaultBody: JUDGE_SYSTEM,
  },
  "compile.system": {
    key: "compile.system",
    label: "规则编译 system",
    group: "编译",
    description: "把自然语言规则编译成蓝图的 system 提示词。改得太松会让校验器接住更多脏数据。",
    variables: [
      { name: "maxRounds", note: "允许的最大回合数", required: true },
      { name: "maxSlots", note: "允许的最多提交槽位数", required: true },
      { name: "maxDimensions", note: "允许的最多评分维度数", required: true },
    ],
    requiredTokens: [],
    defaultBody: COMPILE_SYSTEM,
  },
  "global.addendum": {
    key: "global.addendum",
    label: "全局附加指令",
    group: "全局",
    description: "非空时追加到选手与裁判 system 的末尾，对每一场对局生效。留空即关闭。",
    variables: [],
    requiredTokens: [],
    defaultBody: "",
  },
};

/** Display order for the editor. */
export const PROMPT_ORDER: PromptKey[] = [
  "participant.system",
  "judge.system",
  "compile.system",
  "global.addendum",
];

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function isPromptKey(value: string): value is PromptKey {
  return Object.prototype.hasOwnProperty.call(PROMPT_SLOTS, value);
}

/** Placeholder names actually used by a body, in first-appearance order. */
export function templateVariables(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(VAR_RE)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

/** Required placeholders the body forgot — saving those would starve the prompt. */
export function missingVariables(key: PromptKey, body: string): string[] {
  const present = new Set(templateVariables(body));
  return PROMPT_SLOTS[key].variables
    .filter((v) => v.required && !present.has(v.name))
    .map((v) => v.name);
}

/** Literal protocol markers the body dropped — the parser depends on these. */
export function missingTokens(key: PromptKey, body: string): string[] {
  return PROMPT_SLOTS[key].requiredTokens.filter((token) => !body.includes(token));
}

/** Unknown placeholders survive verbatim, so a typo stays visible instead of vanishing. */
export function renderPromptTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (raw, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : raw,
  );
}

/** Saved override when it is non-empty, otherwise the built-in body. */
export function resolvePromptBody(key: PromptKey, override?: string | null): string {
  const body = override && override.trim() ? override : PROMPT_SLOTS[key].defaultBody;
  return body.trim();
}

/** Appends the configured global instruction, if any, to an assembled system prompt. */
export function withGlobalAddendum(system: string, overrides?: PromptOverrides): string {
  const addendum = resolvePromptBody("global.addendum", overrides?.["global.addendum"]);
  return addendum ? `${system}\n\n${addendum}` : system;
}
