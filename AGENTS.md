# AGENTS.md — 斗场（AI Arena）开发规范

> 本文件对这个仓库里的所有改动生效，优先级高于个人习惯。
> 改代码前先读 §1 与 §2；踩坑清单在 §10，很多错误已经付过一次学费。

## 0. 一句话架构

用户用自然语言写规则 → 编译成 Blueprint（回合数 / 提交槽位 / 评分维度 / 胜负方式）→
引擎只负责「所有人并发出招 → 全部到齐 → 裁判盲化打分」→ 全过程写进 append-only 事件流 → UI 是事件流的 reducer。

第二类对局「预女猎九人局」不走这条管线：它是 `mode: "werewolf"` 的结构化蓝图，
由 `src/engine/werewolf/` 的纯状态机负责发牌、昼夜、投票与胜负；裁判模型只在
「法官发牌」时参与，不口述任何事实。

第四类对局「政变（Coup）」是 `mode: "coup"` 的结构化蓝图，由 `src/engine/coup/` 的纯状态机
负责发牌、宣称、质疑链与胜负；它没有裁判，也没有并发打分——「谁掉了一条命」只由 reducer 决定。
AI 解说（`coup.commentary`）是观众侧旁白，读全牌、不判定、**绝不进玩家 prompt**。

第五类「赛后评分」也不走对局管线：它只读终局 `state.snapshot` 与公开事件，
由 9 位玩家 + 1 位裁判盲评，`src/engine/werewolf/review.ts` 负责打分与聚合，
`review-runtime.ts` 负责调用与落事件。评分永远不能改变胜负、身份或票型。

## 1. 不可违反的六条

1. **rubric 引擎不认识规则语义。** 引擎不解析 `briefing`、不校验动作是否"合理"、不计算收益。它只读 `rounds / slots / rubric / victory` 四项结构（外加可选的 `board`：声明式读数与结算表，引擎只查表、只做加法，不知道「合作」意味着什么）。想加判定逻辑，先问自己是不是该写进规则文本交给裁判。
   九人局是独立的第二类对局：身份、死亡、票型、胜负只由 `src/engine/werewolf/reduce.ts` 的纯函数决定；它同样禁止 I/O、网络和数据库，裁判模型不参与任何事实判定。
2. **`src/engine/round.ts` 是纯函数。** `reduce(state, action) -> { state, effects }`，不许有 `Date.now()` 之外的副作用，不许 I/O、不许网络、不许读数据库。`Date.now()` 只允许出现在生成事件时间戳与 `finish` 里。
3. **thinking 不出座位。** 观众可见；对手不可见；**裁判也不可见**。任何进入 opponent prompt 或 judge prompt 的文本都必须先过迷雾裁剪。
4. **裁判只见字母。** `A/B/C…` 与队伍的映射每轮重新生成，模型名、厂商名、队伍真名一律不进 judge prompt。
5. **事件是唯一真相。** 状态变化必须落成事件；不要为了 UI 方便在数据库里维护第二份"当前状态"。`state.snapshot` 是给崩溃恢复用的，不是真相源。
6. **全员到齐才裁决。** 提交可以先到先落库，但 `call_judge` 只能由"最后一份提交"触发。任何"先交的先被评"的实现都是错的。
   政变的反应窗口同理：并发收集，收齐才结算；多人同时质疑时按顺时针取第一个，只有一人生效。

## 2. 依赖方向

| 层 | 允许 import | 禁止 import |
|---|---|---|
| `src/engine/{types,rng,parse,prompt,round,judge}.ts` | 彼此、`zod` | `node:*`（`blueprint.ts` 的 `node:crypto` 是唯一例外，仅用于确定性哈希）、`next/*`、`@/db`、`@/providers`、`@/lib` |
| `src/engine/werewolf/{types,blueprint,deal,reduce,prompt,speech}.ts` | 彼此、`../types`、`../rng`、`zod` | `node:*`、`next/*`、`@/db`、`@/providers`、`@/lib` |
| `src/engine/werewolf/review.ts` | 上面全部 + `../parse` | `node:*`、`next/*`、`@/db`、`@/providers`、`@/lib` |
| `src/engine/werewolf/review-runtime.ts` | `./review`、`./types`、`@/db`、`@/providers`、`@/lib/bus`、`@/lib/secrets` | `next/*`、`@/components` |
| `src/engine/werewolf/runtime.ts` | 上面全部 + `@/db` + `@/providers` + `@/lib` | `next/*`、`@/components` |
| `src/engine/coup/{types,blueprint,deal,reduce,prompt,commentary,turn}.ts` | 彼此、`../types`、`../rng`、`zod` | `node:*`、`next/*`、`@/db`、`@/providers`、`@/lib` |
| `src/engine/coup/review.ts` | 上面全部 | `node:*`、`next/*`、`@/db`、`@/providers`、`@/lib` |
| `src/engine/coup/{runtime,review-runtime}.ts` | 上面全部 + `@/db` + `@/providers` + `@/lib` | `next/*`、`@/components` |
| `src/engine/runtime.ts` | 上面全部 + `@/db` + `@/providers` + `@/lib` | `next/*`、`@/components` |
| `src/providers/*` | `@/engine/types`、`@/engine/rng` | `@/db`、`@/app`、其它 provider 内部实现 |
| `src/db/*` | `node:sqlite`、`@/engine/types` | `@/providers`、`@/app`、`zod`（校验属于 blueprint） |
| `src/components/*` | React、`@/engine/types`（仅 type） | `@/db`、`@/engine/runtime`、`node:*` |
| `src/app/api/*` | 全部 | 直接写业务逻辑（应委托给 runtime / repo） |

`src/engine/runtime.ts`（rubric）、`src/engine/werewolf/runtime.ts`（九人局）与 `src/engine/coup/runtime.ts`（政变）是**仅有的三个**允许把纯逻辑接到真实世界的文件；`review-runtime.ts` 是九人局的赛后扩展，规则相同。新增能力时先问：这段逻辑放 reducer 还是放 runtime？能放进 reducer 的，一律放进 reducer。

## 3. 目录职责

```
src/engine/types.ts      领域类型（无逻辑）
src/engine/blueprint.ts  蓝图 zod 校验、权重归一化、提交内容校验、哈希
src/engine/round.ts      回合状态机（纯）
src/engine/judge.ts      裁判选择（纯：显式优先 → 避开选手接入方 → 兜底）
src/engine/runtime.ts    副作用：并发调度、模型调用、落库、推事件
src/engine/werewolf/     九人局：纯状态机、发牌、提示词、发言抢救、独立运行时
src/engine/coup/        政变：纯状态机、发牌、提示词、解说、独立运行时
src/engine/coup/review.ts              政变赛后评分纯函数（事实卡、票解析、聚合）
src/engine/coup/commentary.ts          政变 AI 解说（观众侧，读全牌，不进玩家 prompt）
src/engine/coup/turn.ts                政变「一手」的事件折叠：观众事实卡、有序步骤（describeTurnSteps），UI 与解说共用
src/engine/werewolf/review.ts          赛后评分纯函数（事实卡、编年史、prompt、解析、聚合）
src/engine/werewolf/review-runtime.ts  赛后评分副作用（并发调用、事件、用量；独立于游戏 ctx）
src/engine/game.ts       parseAnyBlueprint / 对局类型分流
src/engine/parse.ts      <<<THINK>>> / <<<SUBMIT>>> 增量解析与 JSON 修复
src/engine/prompt.ts     选手/裁判 prompt 组装（迷雾与盲化在这里实现）
src/engine/prompt-templates.ts  内置提示词模板、占位符渲染与协议标记校验（纯字符串）
src/engine/reasoning.ts  思考强度词汇表（档位归一、能力卡→协议类型，纯函数）
src/engine/ledger.ts     声明式账本（board.settle 查表结算、derive 维度、裁判读数对账，纯函数）
src/engine/cache-gate.ts 前缀缓存的并发闸门（同前缀只放行一条，首包到达再放其余；纯 Promise）
src/engine/rng.ts        确定性随机（哈希派生，与调用顺序无关）
src/providers/           四种接入 + SSE 解析 + 拉取模型 + models.dev + 思考参数落线
src/db/schema.ts         DDL、版本号、种子常量
src/db/repo.ts           所有 SQL 都在这，别在 route 里写 SQL
src/lib/bus.ts           进程内事件总线（globalThis 单例）
src/lib/board.ts         战况面板的纯函数（裁判读数裁剪、跨轮折叠、差值）
src/lib/werewolf-frame.ts 九人局视图模型（帧、行动账本、席位状态、发言/旁白清洗，纯函数）
src/lib/pin.ts           「回到对局」记录（替换规则为纯函数 + localStorage 守卫；顶栏芯片读它）
src/lib/match-catalog.ts 对局库检索（状态标签 / 搜索 / 筛选 / 分日；顶栏菜单与「所有对局」页共用）
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
  v8 起 `models` 多了 `call_timeout_ms`（单次调用总时限，毫秒；NULL = 沿用全局默认），
  同样是纯增量 `ALTER`，老对局的快照没有该字段时自然回落到全局默认。
- v9 起 `models` 的种子多出 5 个演练体（`m-mock-e..i`），只为让九人局在没有真实 Key 时也能凑齐 9 席；仍然是纯增量，不改列。
- v11 起种子多出第 10 个演练体 `m-mock-j`：九人局必须有一位裁判（可以与座位同模型，但演练体仍留一个专职的），9 个座位全用 mock 时也凑得齐。v12 对已经升到 v11、但 mock 行是 `syncProviderModels` 随机 id 因而漏种的老库再补一次；之后不再复活用户删掉的 mock（`ensureSeedData` 用 `upgradedFrom < 12` 守卫）。
- v13 起 `matches` 多了 `cached_tokens`（前缀缓存服务过的输入 token 数，是 `tokens_used` 的**子集**，
  不是额外总量），`models` 多了 `provider_cache_mode`（`auto / explicit / none`，NULL = 按 provider kind 推断）。
  两条都是纯增量 `ALTER`，老对局读出来是 0、老模型按 kind 推断。
- 迁移只有两种合法形态，都写在 `repo.ts:migrateIfNeeded()`：
  - **破坏式**：检测到远古表（`LEGACY_TABLES`）→ 全量 DROP + 重建。仅限开发期、且必须在 README 里说明会清空对局。
  - **手术式**：能 `ALTER` 就 `ALTER`；删 `NOT NULL` 列必须建新表 → 搬数据 → DROP → RENAME，并在前后 `PRAGMA foreign_keys = OFF/ON`。
- **种子只在首次建库时写入**（`providers` 表为空）。用户删掉的预设接入方不能因为版本号变动又冒出来——这条踩过。
- 历史对局的配置必须冻结：`matches.blueprint_snapshot_json` 与 `teams / participants.model_json` 都是快照，改模型配置不得影响历史。
- 密钥只存 `data/secrets.json`（0600），永不入库、永不进 git、永不原样返回给前端；对外只给 `••••后四位`，短于 9 位直接全遮。

## 5. 运行时约定

- **并发模型**：`apply()` 是同步的——`reduce` 出状态 → 立即 `dispatch` 每个 effect。`call_participants / call_judge` 只是**发射**异步任务，回调完成后再 `apply(submit|verdict)` 重新进入。**不要在 `apply` 内部 await 任何模型调用**，否则并发提交会互相覆盖状态。
- **进程内单例必须挂 `globalThis`**：`__arenaRuntime`（运行中的 ctx）、`__arenaWerewolf`（九人局 ctx）、`__arenaBus`（订阅表）、`__arenaDb`（SQLite 句柄）。Next.js 给每个 route 单独的模块图，模块级变量不共享——不挂 globalThis 就会出现「暂停对局返回 409 对局不在运行中」。
- **九人局是顺序状态机**：`reduceWerewolf` 每次只推进到下一个需要输入的阶段；`call_seat` 由 runtime 异步发射，到齐后重新进入 reducer。`hunter_shot` / `day_last_words` 允许已死座位提交，其余阶段只叫活人。身份与死亡绝不写进公开日志。狼人夜晚是两段：discuss（低语 + 倾向票）→ decide（看第一轮提议后定刀，可改票）；只剩一狼时跳过 decide，定刀轮弃权回落到第一轮倾向票。
- **看门狗**（阈值都可用环境变量覆盖）：
  - `ARENA_STALL_MS`（180s）连续这么久没有任何新内容 → 判定卡死，中止本次调用（`stream_stalled`）。
  - `ARENA_CALL_TIMEOUT_MS`（30 分钟，`0` = 不限）单次调用总时限，只是计费兜底（`call_timeout`）。
    模型级用 `models.call_timeout_ms` 覆盖，随 `ModelSnapshot` 冻结进对局。
  - 重复片段检测：同一 60 字窗口出现 6 次以上 → 判定在原地打转，立即截断（`thinking_loop`）。
  - `ARENA_MAX_THINKING_CHARS`（2000000）纯内存兜底（`thinking_too_long`），`0` 关闭。
  - 看门狗**按 1 秒轮询**（`setInterval`），不挂在增量回调上：网关静默时永远等不到下一次 delta，
    挂在 `sink()` 里的判定形同虚设。反过来，`touch()` 挂在每个 delta 上给模型续命，
    所以「思考久」不会被误杀——**用总耗时推断跑偏是错的**，`ARENA_NO_SUBMIT_MS` 已退役。
  - **「有字节」与「有内容」是两件事**：provider 的 `onBeat` 在 SSE 的 `:` 心跳、空 delta、
    只带 usage 的帧上都会调 `callWindow.touch()`。只按 `onDelta` 续命会把还在 ping 的网关判成断流。
  - **静默重试**（`ARENA_STALL_RETRY`，默认 1）：剪断时本趟 `attemptChars === 0` 才重开一个新窗口
    （新的 AbortSignal + 新时钟，`rearm()` 做不到这件事）。已吐过内容的断流不重试，否则同一次思考会计费两遍。
  - **补叫（recall）**：弃权是以 submission 形态落库的，所以 `pending` 里有了它、`recover*` 就永不重叫。
    `{kind:"recall"}` 是唯一回滚通道：rubric 只在 `collecting/sudden` 且该座位 `status === "forfeit"` 时成立，
    回滚 `team.forfeits`；九人局只在 `seat.lastForfeitPhase === state.phase` 且该座位仍在 `pending` 里时成立，
    并把座位压进 `state.recalled`——**迟到交卷靠这个白名单被 `submit` 接受，绝不回拨 `queueIndex`**
    （回拨会把下一位重叫一遍）。`enterPhase` 清空 `recalled`，所以一轮只能补叫一次。
- **失败策略**：弃权不阻塞他人；同方累计两次弃权判负；裁判重试耗尽后**按已得分结算，一分未得则判无胜者**——永远不要为了"让对局跑完"伪造裁决。
  九人局：一次失败只让该座位本阶段弃权（狼不投/预不验/巫不用/猎不开枪/发言过麦/投票弃票），连续两次失败标记 AFK 并停叫；绝不补写模型没说过的话。
- **预算**：调用次数 `maxCalls = rounds × seats + rounds + 6`，超限中止并标注 `budget_exceeded`；
  九人局 `maxCalls = min(260, 9 × 3 × maxDays + 20)`；
  **token 只计量、不设限**——`budgetExhausted` 永远不看 tokens，`inputs/outputs` 都没有上限。
- **prompt 前缀只增不改**：每条 prompt 分两段——稳定段（规则/信息边界/旁白规范、公开编年史）在同谱系调用
  之间必须逐字节相同，动态段（牌桌状态、身份与底牌、时序、可选目标、输出协议、本轮要求）全部落在尾部；
  `messages[0].cacheAt` 就是这条分界线。九人局是「历史在前、今天在后」，座位底牌一律在分界线之后
  （否则九席各带一句身份，前缀从第一个字就分叉）；rubric 选手是「已公布的战况在前」；
  赛后评分的 system 对十张票完全一致。理由见 §10「每轮都全价买同一段规则与编年史」。
- **缓存闸门**：写入计费的缓存（`provider_cache_mode: "explicit"`）上，同一相位/同一批评分票只放行第一条，
  其余等它首包到达再发车（`src/engine/cache-gate.ts`，`holdMs` 3s 兜底，闸门关闭时零开销）。
  `auto` 模式不开闸门——DeepSeek / Gemini 的写入不额外收费，串行化只会白等一个 TTFB。
- **思考流节流是「节奏」不是「块大小」**：`openDeltaPump` 每 `ARENA_FLUSH_MS`（80ms）把攒下的内容推一次，
  单包超过 `ARENA_FLUSH_MAX_CHARS`（4096）立即切分；单次调用超过 `ARENA_FLUSH_BUDGET`（600）条事件后
  **只把间隔翻倍**（上限 `ARENA_FLUSH_MAX_INTERVAL_MS`=1000ms），**绝不加大块**。
  原因：按字数设阈值会让流越写越慢——64 字/块是每 90ms 一跳，改成 2048 字/块后同样速度就变成 3 秒一跳
  （实测 93ms → 3034ms），观众看到的是「卡住两秒蹦一段」。
  **绝不丢尾**：`stop()` 必定 flush 尾包，完整文本始终落在 `seat.submitted` 里。
- **观众叙事以「一手」为单位**：`coup.action / reaction / challenge / block / lost / coins`
  由 `coup/turn.ts` 折叠成 `CoupTurnRecord`，UI 与解说共用同一份事实。`coup.action` 的
  `honest / note`、`coup.coins`（带 `before`）与 `coup.hand` 是观众侧必需字段；弃权必须发
  `coup.forfeit`，绝不能被渲染成主动的「收入 / 放过」。模型的原生 reasoning 通道
  （`channel: "reason"`）**不落事件流**：它会把 prompt 原样回显，是「观众看不懂」的主因。
- **观众侧说明 500 字**：`<<<THINK>>>` 是写给观众看的「为什么这么选」，UI 默认只展示前 500 字，
  其余折叠成「展开全文 · 另 N 字」。折叠只发生在显示层，不截断、不丢尾。
- **一手要能摊开成时间轴**：`describeTurnSteps(record)` 把一手拆成有序步骤
  （宣称 → 弃权 → 表态 → 阻挡 → 结质疑 → 质疑阻挡 → 结阻挡 → 掉命 → 金币），每步带座位与原话、
  以及该座位写给观众的自述。时间线卡、右侧「本手」Tab 与解说读同一份，**不许各自拼文案**。
  阻挡在事件流里会出现两次（`coup.reaction` 的 `kind: "block"` 与 `coup.block`），步骤里只留一条。
- **note 必须真的流式到观众**：政变的 `note` 写在 `<<<SUBMIT>>>` 的 JSON 里，`noteField: true` 时
  `SubmissionStreamParser` 要在 submit 模式里增量扫出 `"note"` 的字符串值并 `push` 出去
  （有 `<<<THINK>>>` 草稿时不重复推）。否则模型主路径下观众只会在落地那一刻看到一段静态文字。
  落事件时引擎把 note 截到 300 字，UI 必须取「实时流」与「落地版」中**较长**的那份——
  否则座位卡上的自述会在动作被接受的瞬间变短。
- **断点续跑**：进程一死，`globalThis` 上的 ctx 就没了，所以每个 runtime 在 `apply()` 里
  **先写 `match_checkpoints` 再 `dispatch`**——任何一次模型调用都不许建立在没落盘的状态上。
  续跑走 `POST /api/matches/[id]/recover`（`recoverWerewolfMatch` / `recoverRubricMatch`），
  只重叫当前相位还欠动作的座位（`pending` 里已有的绝不重叫），终局时删掉检查点。
  **恢复是显式的一次点击**：打开旧页面不该替用户烧掉九个座位的调用。
- **赛后评分是终局后的独立管线**：对局一结束，`finishNow` 在微任务里启动 `startWerewolfReview`；
  它不写游戏检查点、不改游戏 state、不占游戏 budget。评分自己是一组 `review.opened / review.ballot / review.verdict`
  事件，9 位玩家 + 1 位裁判并发（默认 3 并发），单票默认 180s、总时限默认 360s。
  进程死在评分中间时，已落的票还在事件流里；页面上的「继续评分」只补叫没有 terminal 票的评委。
  评分是显式的一次调用：打开旧页面不会自动重跑。
  裁判在开局时冻结；它可以是 9 个座位里的某个模型——这时它同时持有座位票与裁判票
  （`planReviewRaters` 给出 `judgeSeat`，prompt 会告诉它自己在评哪一席）。老对局没有裁判时降级为玩家互评。

## 6. Provider 接入规范

- **一律裸 `fetch`，不引 SDK。** SSE 解析统一走 `providers/sse.ts`。
- 必须实现 `ProviderAdapter.call(req, onDelta)`，返回统一 `{ text, thinking, usage, latencyMs }`。
- **reasoning 通道归一**：OpenAI 兼容的 `reasoning_content` / `reasoning`、Anthropic 的 `thinking_delta`、Gemini 的 `thought: true`，都映射到 `onDelta({ thinking })`。
- **思考强度是模型级配置，不是调用参数**：档位/预算存在 `models` 表，随 `ModelSnapshot`
  进对局快照；adapters 一律通过 `providers/reasoning.ts` 换算成各家的线格式，不要自己拼。
- **models.dev 只做能力发现，且必须可失败**：拉取模型时顺带补卡是 best-effort，
  catalogue 不可达绝不能让 `POST /providers/{id}/models` 失败；卡里说 `temperature: false`
  的模型不能再发 `temperature`（否则 GPT-5 档直接 400）。
- **原生 JSON 模式只给裁判与赛后评分表单**（`req.json = true` → `response_format`、`responseMimeType`）。
  选手在牌桌上的回合必须留自由文本，因为它要靠分隔符协议流式输出思考；
  赛后评分是一次「填表」，没有观众旁白、没有流式 thinking，允许对评委和裁判都开 JSON 模式。
- **输出不设上限**：适配器**不发** `max_tokens` / `maxOutputTokens`，模型配置里也没有这个旋钮。
  原因见 §10 的「满思考模型正文为空」：推理 token 与正文共用同一个 completion 窗口，发一个
  2048 的上限就是在赌思考不会吃光预算。只有调用方显式传 `req.maxTokens` 才发。
  Anthropic 的 `max_tokens` 是必填字段，所以发 64000，被模型以 400 拒绝时降级到 8192 重发一次。
- **缓存记账归属**：`usage.promptTokens` 永远是**总输入**。Anthropic 的 `cache_read_input_tokens` /
  `cache_creation_input_tokens` 在 `input_tokens` 之外，adapter 必须加回去；OpenAI 的
  `prompt_tokens_details.cached_tokens` 与 DeepSeek 的 `prompt_cache_hit_tokens` 本来就是子集，直接读；
  Gemini 读 `cachedContentTokenCount`。`cachedPromptTokens` 只用于折算账单，**不进** `tokens` 总量。
- **显式缓存的断点怎么标**：`messages[i].cacheAt` 指向稳定段结尾时，Anthropic adapter 把这条消息切成
  两个 text block 并给前一块挂 `cache_control: {type:"ephemeral"}`，system 另挂一个；前缀短于约 2800 字
  不发断点（低于最小可缓存长度）。其余 provider 忽略这个字段，它们自己按前缀匹配。
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
- 九人局使用同一组 `<<<THINK>>>` / `<<<SUBMIT>>>` 标记，但 JSON 形状按阶段固定（`target` / `vote` / `action` / `speech`）；`coerceWerewolfAction` 负责把 1–9 号座位号转成 0-based 索引，reducer 再校验一次。
- 裁判输出必须是严格 JSON；解析失败带原答案重试一次（temperature 0），再失败才放弃。
- 赛后评分 prompt 是独立的一套：它看完整翻牌（身份、夜间行动、票型、死因）与引擎事实卡，
  但**永远不读** `<<<THINK>>>` 旁白、`reasoning`、其他评委的票；裁判 prompt 只出现 1–9 号座位，
  模型名、厂商名、真名一律不进。评分票由 `parseReviewBallot` 校验，失败带错误重试一次。
- 任何改动 `prompt.ts` 的提交，都要跑 `tests/prompt.test.ts` —— 它断言裁判看不到模型名/队名/thinking，选手看不到对手的 secret 槽位。

## 8. UI 规范

- **只用语义 token**（`ink-0..3 / line / fg / jade / amber / blood / ghost`），组件里禁止写死十六进制。队伍色来自数据（`team.color`），不是主题常量。
- 主题三态（日 / 夜 / 自动）：`<html data-theme>` + `data-mode`；首屏由 `layout.tsx` 的内联脚本决定，避免闪烁。新增页面必须两套主题都过一遍。
- **动画不得承载可读性。** 禁止 `animation: ... both|forwards` 改 `opacity`——合成器不推进时（无头浏览器、冻结的后台标签页）文字会永久停在 `opacity: 0`。
- 批量刷新用 `setTimeout(16)` 合并，**不要用 `requestAnimationFrame`**（在无头环境里根本不触发）。
- 观战台只消费事件流，不发业务请求；所有写操作走 `/api/matches/[id]/intervene`（九人局的暂停/继续）或 `/abort`。

## 9. 测试规范

- 命令：`bun test`（全绿）。**不许联网、不许开端口、不许读写 `data/`。**
- 必测清单（新增能力时必须补）：
  - 蓝图校验：非法字段、权重归一化、重复 key、choice 无选项。
  - 回合状态机：乱序提交结果一致、缺一人不裁决、重复提交被忽略、弃权不阻塞、两次弃权判负、同分触发加时且加时不加分。
  - 计分：队分按队评不按人头（1v2 不吃亏）。
  - 账本：四格矩阵、弃权顶替、越界只报告不夹取、缺一格组合被拒、八轮全卖收在 2/2、
    字母轮换下读数仍按 teamId 绑定、派生维度覆盖裁判值、裁判历史里没有旧字母。
  - 盲化/迷雾：裁判 prompt 不含模型名/队名/thinking；选手 prompt 不含对手 secret 槽位。
  - 协议解析：完整/缺 marker/裸 JSON/围栏/换行/垃圾输入。
  - 裁判选择：显式指定优先、自动避开选手接入方、全同厂兜底、不在裁判池/空池被拒。
  - 预算：`budgetExhausted` 边界。
  - 前缀缓存：九席共用同一段规则头、`cacheAt` 落在编年史末尾、新发言只追加不改写、
    跨轮历史块是上一轮的前缀、十张评分票的 system 逐字节相同、闸门的首条直放/等待/超时兜底。
  - 调用闸门：`watchdogCut`（静默 vs 总时限 vs 都不触发、`0` 关闭、`Infinity` 不触发）、
    `callTimeoutFor`（模型级优先、`null` 回落、`0`/负数回落、全局关闭），以及四种弃权原因的文案。
  - 连接活性与静默重试：`readSse` 的 `onBeat`（心跳行/空帧算活着、无回调时行为不变）、
    `shouldRetryStall`（零字节才重试、有内容不重试、非 stall 不重试、用尽即停）。
  - 补叫：rubric（重新欠动作、`team.forfeits` 回滚、`judging` 拒绝、已答座位拒绝、
    旧检查点缺 `recalled` 仍可续跑）；九人局（解 AFK、清 pending、迟到票被接受、相位已翻拒绝、
    补叫两次不成立、`enterPhase` 清空白名单）。
  - 思考流节奏：`flushIntervalFor` 的退避边界、泵的「按时间必发」「按大小切分不丢字」「stop 冲尾包」。
  - 九人局：发牌三种来源、夜杀/救/毒/验、猎人被刀/被毒/被放逐/枪下无遗言、首夜遗言、
    PK 重投与再平票、自爆、屠神/屠民/狼全死/同批好人优先、空刀/自刀、弃权与 AFK、
    同 seed 重放一致、maxDays；prompt 迷雾（村民/狼/预/女/猎互不看底牌）；事件流 reducer；
    牌桌时序（发言顺序 / 自己的位置 / 已说完 / 还没轮到、PK 只列候选人、投票时谁没开口、
    平安夜从最后发言者下家起）；狼人两段（商量轮不结刀、定刀轮可改票、单狼跳过、
    定刀轮弃权回落到第一轮倾向票）。
  - 思考参数：档位换算 Anthropic 预算（含 `[1024, maxTokens)` 夹取）、Gemini
    `thinkingLevel` 与 `thinkingBudget` 的分支、OpenAI/OpenRouter 两种字段形态、
    models.dev 能力卡匹配（镜像模型的归属判定），以及「不发 `temperature`」的分支。
  - 断点续跑：`recoverWerewolf`（并发相位只补叫欠账、顺序相位只补叫在飞的那一个、
    已交卷座位不重叫、`queueIndex` 不变量、`dawn` 走 `advance`、终局无副作用）、
    `recoverRound`（只叫未交的人 / 全员到齐改叫裁判）、检查点读写与终局清理，
    以及「中断态」：`live:false` 时 `seatStatus` 判「已中断」、当前帧 `sub` 不再是「进行中」、
    `finished` 压过 `live`。
  - 政变：15 张牌守恒、七种行动结算、质疑退钱 / 阻挡不退钱、双重伤害、顺时针优先仲裁、
    证明后洗回抽新、10 金币强制政变、牌堆抽空、回合上限判胜、四席 system 逐字节相同、
    cacheAt 落在编年史末尾、合法动作枚举、非目标阻挡降级为放过、自评不计入、裁判一票等权。
  - 政变观战：一手在下一手开始时封存、`channel === "note"` 才进旁白、反应原话与弃权可见、
    解说按 turn 挂到对应卡片、`coerceCoupMove` 的 1-based→0-based 目标与 `"target": null`、
    中文动作 / 身份别名归一。
  - 政变时间轴：`describeTurnSteps` 的顺序（宣称 → 弃权 → 表态 → 阻挡 → 结质疑 → 质疑阻挡 →
    结阻挡 → 掉命 → 金币）、阻挡只出一步不重复成两条反应、每步带该座位自述、弃权文案不被读成主动选择。
  - 政变旁白流：`noteField` 模式下 submit 里的 `note` 边收边推（首包就能看到字、转义引号不截断、
    有 THINK 草稿时不重复推）、落地文案取长不取短（实时流 900 字不被引擎的 300 字覆盖）、
    `phase.changed` 清空本阶段自述后仍能继续累积。
  - 赛后评分：默认规则与蓝图覆盖归一化、事实卡（身份/夜间/票型/死因/查验/用药/枪口）、
    编年史截断、评委/裁判 prompt 的盲化（无模型名、无 thinking）、9 行票解析（缺行/重复/0-based/
    越界/围栏/评语截断）、自评不计入本人均分、去极值、裁判 2 票、裁判同座仍出两张票、缺票分母、样本不足、
    败方第一、并列裁决、`reviewAttempt` 只认最高 attempt、终局后 SSE 保持打开。
- 测试夹具用构造器（`buildState` / `play`），不要依赖真实模型或数据库。

## 10. 踩过的坑

| 症状 | 真因 | 正确做法 |
|---|---|---|
| 暂停/插话接口报「对局不在运行中」 | Next.js 每个 route 独立模块图，模块级 Map 不共享 | 单例挂 `globalThis` |
| 观战台永远停在「连接中」 | 依赖 `requestAnimationFrame` 合并事件，无头环境不触发 | 改 `setTimeout` |
| 推演区一片空白但有光标 | `animation: both` 把 opacity 冻结在 0 | 动画只做位移，不碰透明度 |
| 打开 `127.0.0.1:3099` 页面不 hydrate | Next dev 把 127.0.0.1 当跨域拦截 | `allowedDevOrigins: ["127.0.0.1","localhost"]` |
| 选手一直不提交 | 网关把全部输出塞进 reasoning 通道，正文为空 | 空正文时回退解析 reasoning 通道 |
| 裁判 JSON 解析失败 | 弱模型把推理写进正文、不守 JSON | 原生 `response_format: json_object` + 一次严格修复重试 |
| 一轮卡住好几分钟 | 模型无限独白，从不输出 marker | 时间阈值 + 重复片段检测 + 硬超时 |
| 满思考模型 5 分钟就被判「跑偏」 | 用「多少秒没提交」当质量判据，长推理与跑偏在时间轴同形 | 只砍「没新内容」（`ARENA_STALL_MS`），总时长交给模型级 `call_timeout_ms` |
| 实时推演停在半句、看着像卡死 | 400 块后直接丢增量；no-submit 判定只在增量回调里跑，网关静默就永不触发 | 超限改为合并发送；看门狗改 1 秒轮询 |
| 思考写到三万字后「卡、蹦、不丝滑」 | 节流按字符数：400 块后每块 2048 字，观众的刷新间隔从 93ms 掉到 3034ms；UI 又把整段裁判推演每帧重建一遍 | 节流改时间节奏（`ARENA_FLUSH_MS`）；直播面只渲染尾部窗口；卡片 `memo` + 只重建被写的那个座位 |
| 满思考模型「弃权 · no_protocol_markers」 | 发了 `max_tokens: 2048`，推理把预算吃光，正文一字未出 | 输出不设上限：适配器不发 `max_tokens` |
| 网关在思考期只发 `: ping`，却被判 `stream_stalled` | 续命只挂在 `onDelta` 上，`readSse` 把注释行直接丢掉，空 delta/usage 帧也不回调 | 加 `onBeat`：任何字节都 `touch()`，与"有没有正文"解耦 |
| 一次 180 秒抖动直接输掉一局，且「从断点继续」救不回 | 弃权写进 `pending` 就等于"已交卷"，`recover*` 只补欠动作的座位，静默剪断又被判不可重试 | 零字节静默重开一次；再给 `{kind:"recall"}` 一条人工回滚通道，迟到交卷走 `state.recalled` 白名单 |
| 只有一方的血量在掉（旧版） | 模型把 target 填成自己的座位 | 引擎侧拒绝自伤 |
| 同一轮两方血量互换（R05 青方 −6） | 裁判把上一轮的 `publicSummary` 原样读进本轮，而 A/B 每轮重抽；本轮双方出招相同时无从分辨 | 账本按 teamId 记账；裁判历史不出现旧字母，只给按本轮字母重写的结构化账面 |
| 血线给出 4.5 / 6.5 这种不可能的数 | `bar = 5 + Δ血` 由模型口算 | 维度声明 `derive`，引擎算分；裁判写只用于对账 |
| 改版本号后预设接入方"复活" | 种子逻辑跟着版本号重灌 | 种子只在 providers 表为空时写入 |
| 旧人格卡字段导致迁移失败 | `ALTER TABLE DROP COLUMN` 删不掉 NOT NULL | 建新表搬数据再改名 |
| 九人局天亮后卡在「遗言」 | runtime 把死座一律挡在调用之外 | 死座只允许 `day_last_words` / `hunter_shot` 两个阶段 |
| 九人局猎人被放逐后卡住 | 同上，猎人已死但需要开枪 | 同上 |
| 公开日志泄漏狼队友/查验/刀口 | prompt 直接拼了 state 而不是 `seatView` | 只经 `seatView` 取数，公开日志只存公开事实 |
| PK 台上的人参与重投 | 投票人集合没排除候选人 | `pkVoters: non_candidates`，候选人只发言 |
| 九人局身份被裁判模型口述 | 把裁判当成了规则执行者 | 裁判只发牌（可选），死亡/胜负只由引擎算 |
| 点了「从断点继续」，对局跑起来了，状态却又变回 `interrupted` | `ensureRuntime()` 里的 `markOrphansInterrupted()` 是异步的，落在恢复之后，把 `running` 又改了回去 | 扫库跳过活着的 ctx（`markOrphansInterrupted((id) => isLive(id))`），恢复接口先 `await whenBooted()` |
| 进程早没了，页面还在「推演中」，也没有继续按钮 | 席位状态只由事件推导（最后一条 `seat.thinking.delta` 把座位冻在 `thinking`），「进程还在不在」这个信号压根没进视图 | `GET /api/matches/[id]` 返回 `live`；`TableState.live` 参与 `seatStatus` / `buildFrames` / 直播头；横幅按 `!live` 而不是 `resumable` 出现；SSE `onopen` 重读一次状态 |
| 赛后评分把自己抬到第一 | 自评票和别人的票等权 | 自评收集并展示，但不计入本人均分；面板单列 `selfTotal` |
| 终局后评分事件一个都收不到 | 页面在 `match.status === "finished"` 时提前 `return`，没开 SSE | 终局后保持 SSE 直到页面卸载；评分与对局用同一条事件流 |
| 评分把对局 reducer 搅乱 | 把 10 次评分调用塞进 `werewolf/reduce.ts` 的 pending | 评分是独立事件管线；只读终局快照与公开事件，不碰游戏 state/检查点/budget |
| 评分 prompt 把思考或模型名带进去 | 直接拼 `state` 或 roster，而不是事实卡 | 只经 `collectFacts` / `renderChronicle` 取公开事实；裁判只见 1–9 号座位 |
| 终局后「谁最会玩」被切在视口外，滚也滚不到 | `.ww-page` 整页钉死 `height: calc(100vh - 57px)` + `overflow: hidden`，终局追加的评分面板只能被裁掉；窄屏那条 `height: auto` 又写在基础规则之前，等特异性下被反超 | 终局翻牌后给 `<main>` 打 `data-finished`，让页面回到文档流滚动，胶片用 `clamp()` 保持有界高度；`.ww-page` 基础块必须排在窄屏媒体查询之前 |
| 前置位玩家说「后面的人还没发言，所以他们有问题」 | prompt 给了发言顺序的规则，却没给「本轮谁先说、谁已经说完」的状态；模型把轮次空缺当成证据 | 座位 prompt 注入牌桌时序；明确「未轮到 ≠ 沉默」，并写明弃权也会留一条「过麦」 |
| 平安夜第二天，上一日最后发言者又第一个开口 | `beginDay` 拿 `lastSpeaker` 当顺时针锚点，而 `clockwise` 从锚点本人开始；死者锚点靠被过滤才恰好落到下家 | 平安夜锚点改为 `(lastSpeaker + 1) % seats` |
| 后置位模型说「6 号至今没发言」，而 6 号早说过 | 编年史每条只留前 260 字，结论被砍掉；总量 6000 字又从头截断，当天最早几条直接消失 | 今天/历史分段，今天永不截断；裁剪改成保头保尾（结论在尾部） |
| 每轮都按全价重买同一段规则与编年史 | 「存活 / 轮次 / 时钟」排在最前，长历史落在会变的那段之后；九席 system 第一行各不相同 | 规则在前、身份在后；历史在前、今天在后；分界点写进 `cacheAt` |
| 十张评分票各买一遍同一份大包 | 每张票的 system 第一行都是自己的座位号 | system 全票一致，身份与「你的评分表」挪到 user 尾巴 |
| 狼人第一轮就定刀，先发言的狼听不到队友反驳，1:1:1 直接交给种子 | 把「低语」和「定刀」压成同一次提交 | 两段式 discuss → decide；定刀轮亮出第一轮提议，可以改票 |
| 政变每一手都变成「收入」，模型自述却在讲征税 | `coerceCoupMove` 用 `Number(content.target)`，`null` 变 0，`tax` 被判定带了目标 → 整手作废、回落收入 | 目标单独解析：`null` / `""` → null，数字按 1-based 减一；弃权发 `coup.forfeit` |
| 政变观战台满屏英文碎念、还漏 prompt 原文 | `seat.thinking.delta` 混了 `reason` 通道，frame 无条件拼接 | 只吃 `channel === "note"`；reason 留在 checkpoint，不落事件 |
| 政变金币与手牌永远不动 | `gain / transfer / refund / prove` 只改 state，不 emit | 余额变化发 `coup.coins`（带 before），亮牌换牌发 `coup.hand` |
| 政变观战台「看不懂」：没有轨迹、点了没反应、看不到思维 | 时间线只画最近 12 手且每张卡截两行；座位卡的 `onClick` 只改边框颜色（`focused` 没接任何内容）；note 被引擎截到 300 字又在 UI 里 clamp 成两行；submit JSON 里的 `note` 根本不流式推，主路径下实时区一个字都没有 | 时间线全量 + 点卡 pin 进右侧「本手」Tab；`describeTurnSteps` 展开有序步骤；`focusSeat` 打开座位档案（实时打字机 + 历史自述）；`noteField` 模式下增量推 `note`；落地文案取长不取短 |
| 政变一手内部看不到「谁已经表了态」 | `advanceReaction` 收齐才 emit 全部 `coup.reaction` | 这是设计：反应窗口并发收集，收齐才结算。UI 必须明说「还在等 1、3、4 号表态」，别让观众以为是没数据 |

## 11. 常见扩展任务

**新增一种玩法**：只写 `rulesets/<slug>.md`（自然语言）+ `<slug>.blueprint.json`（结构化）。不改引擎。若编译产物不合格，改 `src/engine/prompt-templates.ts` 的编译模板（或直接在 `/prompts` 改），而不是去改校验器放水。
**九人局变体**：改 `rulesets/werewolf-nine.blueprint.json` 的 `rules`（自救、平票、遗言、天数、狼刀规则），或复制一份新 slug；不要改 `werewolf/reduce.ts` 来放水。
**政变变体**：改 `rulesets/coup-four.blueprint.json` 的 `rules`（起始金币、政变费用、强制政变线、偷窃上限、回合上限），或加一把新 slug；人数写在蓝图 `seats`，引擎按 N 发牌。不要为某条 house rule 改 `coup/reduce.ts`。

**新增提交槽位**：在蓝图里加 slot，UI 自动生成 chip，不必改组件。槽位类型只有 `text / number / choice`，不要扩充——扩充意味着引擎开始理解语义。

**新增评分维度**：写在蓝图的 `rubric.dimensions`，权重会自动归一化。不要写进代码。

**新增事件类型**：同时更新 `types.ts:EventType`、`ArenaView.tsx:applyEvent`（九人局的事件在 `WerewolfTable.tsx:applyWerewolfEvent`）、以及 §9 的测试；事件 payload 必须 JSON 可序列化且体积有界（thinking 增量已按 `ARENA_FLUSH_MS` 节奏切块，别把整段塞进每一条）。

**新增判定规则（慎）**：先确认能不能用"规则文本 + 裁判评分"表达。只有当判定是确定性的、且必须复现时才进引擎，并同时补一条重放测试。

**新增确定性结算（`board.settle`）**：规则里"双方各出 X/Y → 各掉几点"这种能列成表的，写进蓝图的
`board.settle`（`by` 指向一个 `choice` 槽位，`cells` 必须穷尽组合），分数用维度的 `derive` 钉死。
引擎按 teamId 记账，裁判写进 `state` 的数只用于对账（不一致 → `board_mismatch` 并采纳引擎值）。
理由：字母每轮重抽，让模型读着历史文本手算，等于让它在两个身份之间做排列题——这条已经出过事故。

## 12. 提交前检查

```bash
bun test          # 全绿
npx tsc --noEmit  # 零错误
bun run build     # 零 warning
```

外加三条人工确认：

1. 新页面在日间与夜间都能读，没有硬编码颜色。
2. 新 prompt 不泄漏 thinking、不泄漏身份（跑 `tests/prompt.test.ts`）。
3. 动了 schema 就跑了 `bun run db:migrate`，并确认老库能迁移而不是报错。
