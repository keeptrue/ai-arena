# AGENTS.md — 斗场（AI Arena）开发规范

> 本文件对这个仓库里的所有改动生效，优先级高于个人习惯。
> 改代码前先读 §1 与 §2；踩坑清单在 §10，很多错误已经付过一次学费。

## 0. 一句话架构

用户用自然语言写规则 → 编译成 Blueprint（回合数 / 提交槽位 / 评分维度 / 胜负方式）→
引擎只负责「所有人并发出招 → 全部到齐 → 裁判盲化打分」→ 全过程写进 append-only 事件流 → UI 是事件流的 reducer。

## 1. 不可违反的六条

1. **引擎不认识规则语义。** 引擎不解析 `briefing`、不校验动作是否"合理"、不计算收益。它只读 `rounds / slots / rubric / victory` 四项结构。想加判定逻辑，先问自己是不是该写进规则文本交给裁判。
2. **`src/engine/round.ts` 是纯函数。** `reduce(state, action) -> { state, effects }`，不许有 `Date.now()` 之外的副作用，不许 I/O、不许网络、不许读数据库。`Date.now()` 只允许出现在生成事件时间戳与 `finish` 里。
3. **thinking 不出座位。** 观众可见；对手不可见；**裁判也不可见**。任何进入 opponent prompt 或 judge prompt 的文本都必须先过迷雾裁剪。
4. **裁判只见字母。** `A/B/C…` 与队伍的映射每轮重新生成，模型名、厂商名、队伍真名一律不进 judge prompt。
5. **事件是唯一真相。** 状态变化必须落成事件；不要为了 UI 方便在数据库里维护第二份"当前状态"。`state.snapshot` 是给崩溃恢复用的，不是真相源。
6. **全员到齐才裁决。** 提交可以先到先落库，但 `call_judge` 只能由"最后一份提交"触发。任何"先交的先被评"的实现都是错的。

## 2. 依赖方向

| 层 | 允许 import | 禁止 import |
|---|---|---|
| `src/engine/{types,rng,parse,prompt,round,judge}.ts` | 彼此、`zod` | `node:*`（`blueprint.ts` 的 `node:crypto` 是唯一例外，仅用于确定性哈希）、`next/*`、`@/db`、`@/providers`、`@/lib` |
| `src/engine/runtime.ts` | 上面全部 + `@/db` + `@/providers` + `@/lib` | `next/*`、`@/components` |
| `src/providers/*` | `@/engine/types`、`@/engine/rng` | `@/db`、`@/app`、其它 provider 内部实现 |
| `src/db/*` | `node:sqlite`、`@/engine/types` | `@/providers`、`@/app`、`zod`（校验属于 blueprint） |
| `src/components/*` | React、`@/engine/types`（仅 type） | `@/db`、`@/engine/runtime`、`node:*` |
| `src/app/api/*` | 全部 | 直接写业务逻辑（应委托给 runtime / repo） |

`src/engine/runtime.ts` 是**唯一**允许把纯逻辑接到真实世界的文件。新增能力时先问：这段逻辑放 reducer 还是放 runtime？能放进 reducer 的，一律放进 reducer。

## 3. 目录职责

```
src/engine/types.ts      领域类型（无逻辑）
src/engine/blueprint.ts  蓝图 zod 校验、权重归一化、提交内容校验、哈希
src/engine/round.ts      回合状态机（纯）
src/engine/judge.ts      裁判选择（纯：显式优先 → 避开选手接入方 → 兜底）
src/engine/runtime.ts    副作用：并发调度、模型调用、落库、推事件
src/engine/parse.ts      <<<THINK>>> / <<<SUBMIT>>> 增量解析与 JSON 修复
src/engine/prompt.ts     选手/裁判 prompt 组装（迷雾与盲化在这里实现）
src/engine/prompt-templates.ts  内置提示词模板、占位符渲染与协议标记校验（纯字符串）
src/engine/reasoning.ts  思考强度词汇表（档位归一、能力卡→协议类型，纯函数）
src/engine/rng.ts        确定性随机（哈希派生，与调用顺序无关）
src/providers/           四种接入 + SSE 解析 + 拉取模型 + models.dev + 思考参数落线
src/db/schema.ts         DDL、版本号、种子常量
src/db/repo.ts           所有 SQL 都在这，别在 route 里写 SQL
src/lib/bus.ts           进程内事件总线（globalThis 单例）
src/lib/board.ts         战况面板的纯函数（裁判读数裁剪、跨轮折叠、差值）
src/lib/secrets.ts       密钥读写与掩码
src/lib/compile.ts       自然语言 → 蓝图
src/lib/rulesets.ts      内置规则同步
```

## 4. 数据与迁移

- **改表必须递增 `SCHEMA_VERSION`**（`src/db/schema.ts`）。不递增的话老库不会走迁移，运行时会在列上炸。
  v5 起 `models` 多了 `reasoning_effort / thinking_budget / card_json`，迁移是纯增量 `ALTER`。
  v6 起 `matches` 多了 `judge_json`（开局冻结裁判），同样是纯增量 `ALTER`；老对局该列为
  NULL，读取时回退到最新一条 `judgements.judge_json`。
  v7 起 `models.max_tokens` 退役：输出不设上限，新库不再建这一列，老库残留的列不再读取。
- 迁移只有两种合法形态，都写在 `repo.ts:migrateIfNeeded()`：
  - **破坏式**：检测到远古表（`LEGACY_TABLES`）→ 全量 DROP + 重建。仅限开发期、且必须在 README 里说明会清空对局。
  - **手术式**：能 `ALTER` 就 `ALTER`；删 `NOT NULL` 列必须建新表 → 搬数据 → DROP → RENAME，并在前后 `PRAGMA foreign_keys = OFF/ON`。
- **种子只在首次建库时写入**（`providers` 表为空）。用户删掉的预设接入方不能因为版本号变动又冒出来——这条踩过。
- 历史对局的配置必须冻结：`matches.blueprint_snapshot_json` 与 `teams / participants.model_json` 都是快照，改模型配置不得影响历史。
- 密钥只存 `data/secrets.json`（0600），永不入库、永不进 git、永不原样返回给前端；对外只给 `••••后四位`，短于 9 位直接全遮。

## 5. 运行时约定

- **并发模型**：`apply()` 是同步的——`reduce` 出状态 → 立即 `dispatch` 每个 effect。`call_participants / call_judge` 只是**发射**异步任务，回调完成后再 `apply(submit|verdict)` 重新进入。**不要在 `apply` 内部 await 任何模型调用**，否则并发提交会互相覆盖状态。
- **进程内单例必须挂 `globalThis`**：`__arenaRuntime`（运行中的 ctx）、`__arenaBus`（订阅表）、`__arenaDb`（SQLite 句柄）。Next.js 给每个 route 单独的模块图，模块级变量不共享——不挂 globalThis 就会出现「暂停对局返回 409 对局不在运行中」。
- **看门狗**（阈值都可用环境变量覆盖）：
  - `ARENA_CALL_TIMEOUT_MS`（180s）单次调用硬超时 → 该方本轮弃权。
  - `ARENA_NO_SUBMIT_MS`（150s）还没开始写提交块 → 判定跑偏，截断。
  - 重复片段检测：同一 60 字窗口出现 6 次以上 → 判定在原地打转，立即截断。
  - `ARENA_MAX_THINKING_CHARS`（300000）纯内存兜底——放宽到几乎只防真死循环，长度不再是主要闸门。
  - 看门狗**按 1 秒轮询**（`setInterval`），不挂在增量回调上：网关静默时永远等不到下一次 delta，
    挂在 `sink()` 里的判定形同虚设。
- **失败策略**：弃权不阻塞他人；同方累计两次弃权判负；裁判重试耗尽后**按已得分结算，一分未得则判无胜者**——永远不要为了"让对局跑完"伪造裁决。
- **预算**：调用次数 `maxCalls = rounds × seats + rounds + 6`，超限中止并标注 `budget_exceeded`；
  **token 只计量、不设限**——`budgetExhausted` 永远不看 tokens，`inputs/outputs` 都没有上限。
- **思考流节流**：前 400 块按 64 字合并推送，之后改为每 `ARENA_COARSE_FLUSH_CHARS`（2048）字一块继续推，
  **绝不丢尾**。丢尾会让实时推演停在半句、看起来像卡死，而真正的全文要等 `seat.submitted` 才落到 UI。
  完整文本始终落在 `seat.submitted` 里。
- **观众侧说明 500 字**：`<<<THINK>>>` 是写给观众看的「为什么这么选」，UI 默认只展示前 500 字，
  其余折叠成「展开全文 · 另 N 字」。折叠只发生在显示层，不截断、不丢尾。

## 6. Provider 接入规范

- **一律裸 `fetch`，不引 SDK。** SSE 解析统一走 `providers/sse.ts`。
- 必须实现 `ProviderAdapter.call(req, onDelta)`，返回统一 `{ text, thinking, usage, latencyMs }`。
- **reasoning 通道归一**：OpenAI 兼容的 `reasoning_content` / `reasoning`、Anthropic 的 `thinking_delta`、Gemini 的 `thought: true`，都映射到 `onDelta({ thinking })`。
- **思考强度是模型级配置，不是调用参数**：档位/预算存在 `models` 表，随 `ModelSnapshot`
  进对局快照；adapters 一律通过 `providers/reasoning.ts` 换算成各家的线格式，不要自己拼。
- **models.dev 只做能力发现，且必须可失败**：拉取模型时顺带补卡是 best-effort，
  catalogue 不可达绝不能让 `POST /providers/{id}/models` 失败；卡里说 `temperature: false`
  的模型不能再发 `temperature`（否则 GPT-5 档直接 400）。
- **原生 JSON 模式只给裁判**（`req.json = true` → `response_format`、`responseMimeType`）。选手必须留自由文本，因为它要靠分隔符协议流式输出思考。
- **输出不设上限**：适配器**不发** `max_tokens` / `maxOutputTokens`，模型配置里也没有这个旋钮。
  原因见 §10 的「满思考模型正文为空」：推理 token 与正文共用同一个 completion 窗口，发一个
  2048 的上限就是在赌思考不会吃光预算。只有调用方显式传 `req.maxTokens` 才发。
  Anthropic 的 `max_tokens` 是必填字段，所以发 64000，被模型以 400 拒绝时降级到 8192 重发一次。
- 错误一律抛 `ProviderError(status, body, retryable)`：429 / 5xx / 网络错误可重试，401 / 403 / 4xx 立即失败。重试 3 次，退避 250ms / 1s / 3s。
- 新增 provider 类型要同步四处：`ProviderKind`、`providers/index.ts` 注册表、`schema.ts` 的 CHECK 约束、`list-models.ts` 的列模型分支。

## 7. 提示词与协议

- 选手输出协议固定为：

  ```
  <<<THINK>>>
  （观众可见，对手与裁判都看不到）
  <<<SUBMIT>>>
  {"slot_key": ...}
  ```

  解析器必须容忍：缺 marker、裸 JSON、代码围栏、JSON 内嵌 thinking、正文里的裸换行、旧 `<<<ACT>>>` 别名。
- **槽位定义只能来自 blueprint**，prompt 里不许出现硬编码的 `bid` / `move` / `taunt`。
- 裁判输出必须是严格 JSON；解析失败带原答案重试一次（temperature 0），再失败才放弃。
- 任何改动 `prompt.ts` 的提交，都要跑 `tests/prompt.test.ts` —— 它断言裁判看不到模型名/队名/thinking，选手看不到对手的 secret 槽位。

## 8. UI 规范

- **只用语义 token**（`ink-0..3 / line / fg / jade / amber / blood / ghost`），组件里禁止写死十六进制。队伍色来自数据（`team.color`），不是主题常量。
- 主题三态（日 / 夜 / 自动）：`<html data-theme>` + `data-mode`；首屏由 `layout.tsx` 的内联脚本决定，避免闪烁。新增页面必须两套主题都过一遍。
- **动画不得承载可读性。** 禁止 `animation: ... both|forwards` 改 `opacity`——合成器不推进时（无头浏览器、冻结的后台标签页）文字会永久停在 `opacity: 0`。
- 批量刷新用 `setTimeout(16)` 合并，**不要用 `requestAnimationFrame`**（在无头环境里根本不触发）。
- 观战台只消费事件流，不发业务请求；所有写操作走 `/api/matches/[id]/intervene`。

## 9. 测试规范

- 命令：`bun test`（当前 134 项）。**不许联网、不许开端口、不许读写 `data/`。**
- 必测清单（新增能力时必须补）：
  - 蓝图校验：非法字段、权重归一化、重复 key、choice 无选项。
  - 回合状态机：乱序提交结果一致、缺一人不裁决、重复提交被忽略、弃权不阻塞、两次弃权判负、同分触发加时且加时不加分。
  - 计分：队分按队评不按人头（1v2 不吃亏）。
  - 盲化/迷雾：裁判 prompt 不含模型名/队名/thinking；选手 prompt 不含对手 secret 槽位。
  - 协议解析：完整/缺 marker/裸 JSON/围栏/换行/垃圾输入。
  - 裁判选择：显式指定优先、自动避开选手接入方、全同厂兜底、不在裁判池/空池被拒。
  - 预算：`budgetExhausted` 边界。
  - 思考参数：档位换算 Anthropic 预算（含 `[1024, maxTokens)` 夹取）、Gemini
    `thinkingLevel` 与 `thinkingBudget` 的分支、OpenAI/OpenRouter 两种字段形态、
    models.dev 能力卡匹配（镜像模型的归属判定），以及「不发 `temperature`」的分支。
- 测试夹具用构造器（`buildState` / `play`），不要依赖真实模型或数据库。

## 10. 踩过的坑

| 症状 | 真因 | 正确做法 |
|---|---|---|
| 暂停/插话接口报「对局不在运行中」 | Next.js 每个 route 独立模块图，模块级 Map 不共享 | 单例挂 `globalThis` |
| 观战台永远停在「连接中」 | 依赖 `requestAnimationFrame` 合并事件，无头环境不触发 | 改 `setTimeout` |
| 推演区一片空白但有光标 | `animation: both` 把 opacity 冻结在 0 | 动画只做位移，不碰透明度 |
| 打开 `127.0.0.1:3000` 页面不 hydrate | Next dev 把 127.0.0.1 当跨域拦截 | `allowedDevOrigins: ["127.0.0.1","localhost"]` |
| 选手一直不提交 | 网关把全部输出塞进 reasoning 通道，正文为空 | 空正文时回退解析 reasoning 通道 |
| 裁判 JSON 解析失败 | 弱模型把推理写进正文、不守 JSON | 原生 `response_format: json_object` + 一次严格修复重试 |
| 一轮卡住好几分钟 | 模型无限独白，从不输出 marker | 时间阈值 + 重复片段检测 + 硬超时 |
| 实时推演停在半句、看着像卡死 | 400 块后直接丢增量；no-submit 判定只在增量回调里跑，网关静默就永不触发 | 超限改为合并发送；看门狗改 1 秒轮询 |
| 满思考模型「弃权 · no_protocol_markers」 | 发了 `max_tokens: 2048`，推理把预算吃光，正文一字未出 | 输出不设上限：适配器不发 `max_tokens` |
| 只有一方的血量在掉（旧版） | 模型把 target 填成自己的座位 | 引擎侧拒绝自伤 |
| 改版本号后预设接入方"复活" | 种子逻辑跟着版本号重灌 | 种子只在 providers 表为空时写入 |
| 旧人格卡字段导致迁移失败 | `ALTER TABLE DROP COLUMN` 删不掉 NOT NULL | 建新表搬数据再改名 |

## 11. 常见扩展任务

**新增一种玩法**：只写 `rulesets/<slug>.md`（自然语言）+ `<slug>.blueprint.json`（结构化）。不改引擎。若编译产物不合格，改 `src/engine/prompt-templates.ts` 的编译模板（或直接在 `/prompts` 改），而不是去改校验器放水。

**新增提交槽位**：在蓝图里加 slot，UI 自动生成 chip，不必改组件。槽位类型只有 `text / number / choice`，不要扩充——扩充意味着引擎开始理解语义。

**新增评分维度**：写在蓝图的 `rubric.dimensions`，权重会自动归一化。不要写进代码。

**新增事件类型**：同时更新 `types.ts:EventType`、`ArenaView.tsx:applyEvent`、以及 §9 的测试；事件 payload 必须 JSON 可序列化且体积有界（thinking 增量已按 64 字切块，别把整段塞进每一条）。

**新增判定规则（慎）**：先确认能不能用"规则文本 + 裁判评分"表达。只有当判定是确定性的、且必须复现时才进引擎，并同时补一条重放测试。

## 12. 提交前检查

```bash
bun test          # 134 项必须全绿
npx tsc --noEmit  # 零错误
bun run build     # 零 warning
```

外加三条人工确认：

1. 新页面在日间与夜间都能读，没有硬编码颜色。
2. 新 prompt 不泄漏 thinking、不泄漏身份（跑 `tests/prompt.test.ts`）。
3. 动了 schema 就跑了 `bun run db:migrate`，并确认老库能迁移而不是报错。
