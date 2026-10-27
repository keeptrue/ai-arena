# 政变（Coup）第三类对局：实施计划

> 状态：**视觉已定**（观战台 08）。代码未动，等待开工指令。

## 0. 一句话方案

在 `src/engine/coup/` 下新增一套**独立纯状态机**（与 `werewolf/` 平级），用「行动声明 → 并发反应 → 结算脚本机」把 Coup 的质疑链变成可复现的确定性代码；runtime 只负责并发调解、落事件、写检查点；UI 新增一张**浅色、信息优先**的观战牌桌。

## 1. 目标与验收

**目标**：4 人 Coup 从发牌打到只剩一人，全程事件流可回放，终局翻牌并给出赛后评分。

**验收（缺一条不算完成）**：

1. `bun test` 全绿，新增 ≥7 个测试文件、≥60 条断言。
2. `npx tsc --noEmit` 零错误；`bun run build` 零 warning。
3. 4 个 mock 演练体能跑完一整局，`matches` 落 `finished`，`winner_team_id` 指向唯一赢家。
4. 六条规则断言由测试钉死：质疑成功退金币、**阻挡不退金币**、双重危险、顺时针优先仲裁、证明成功后洗回抽新、10 金币强制政变。
5. `kill -9` 后点「继续对局」能从检查点补叫，已交卷座位不重叫。
6. 终局自动起评分，4 张玩家票落库并聚合出「最会玩」。
7. `/coup/[matchId]` 在日/夜两套主题下都可读，无硬编码颜色。

## 2. 为什么必须是第三类对局

- **rubric 引擎**：规则语义（谁能挡谁、质疑链）会被迫写进裁判 prompt，违反 §1「引擎不认识规则语义」，且「他到底有没有公爵」不可复现。
- **九人局 reducer**：相位是固定日程；Coup 的相位深度由玩家反应决定，同一次行动可能 1 步也可能 4 步。
- **`board.settle` 查表**：Coup 的身份真假是隐藏信息，查表无从查起。

结论：新建 `mode: "coup"`，`GameKind` 扩成三值。

## 3. 规则口径（冻结为标准版）

| 判定 | 取值 |
|---|---|
| 质疑行动成功（行动者亮不出牌） | 行动者失 1 影响力，行动作废，**已付金币全额退回** |
| 行动被阻挡成立 | 行动失败，**已付金币不退** |
| 质疑阻挡成功（阻挡者亮不出牌） | 阻挡者失 1 影响力，阻挡失效，行动照常生效 |
| 阻挡范围 | 外援=任何玩家可挡（公爵）；刺杀=仅目标（伯爵夫人）；偷窃=仅目标（队长/大使） |
| 阻挡是否可被质疑 | 可 |
| 证明成功后 | 亮牌 → **洗回牌堆** → 随机补抽 1 张，手牌数不变 |
| 10 金币 | 回合开始 ≥10 时唯一合法行动是政变 |
| 收入 / 政变 | 不可质疑、不可阻挡 |
| 偷窃上限 | `min(2, 目标金币)` |
| 失牌选择 | 由本人选择翻开哪一张 |
| 牌堆抽空 | 能抽几张抽几张（规则书未规定，通行裁定） |
| 回合上限 | 60 回合后按（影响力 → 金币）判胜，仍并列则平局 |

**明确不做**：Inquisitor 变体、2 人三牌堆变体、7–10 人扩牌、阵营团队规则。

## 4. 状态机

### 4.1 相位

```
dealing
  └─ action_select        （叫 1 人：选行动 + 嘴炮）
       ├─ [收入/政变] ───────────────────→ 结算 ──→ 下一回合
       └─ action_reaction （并行叫 N−1 人：pass / challenge / block + 嘴炮）
            ├─ 无人质疑无人阻挡 ──────────→ 结算
            ├─ 有人质疑 ─┬─ 行动者失败 → 作废退钱 → 下一回合
            │             └─ 行动者证明 → 检查阻挡
            └─ 有人阻挡 ──→ block_reaction（并行叫 N−1 人：pass / challenge）
                              ├─ 无人质疑阻挡 → 行动被阻挡 → 结算
                              └─ 有人质疑 ─┬─ 阻挡者证明 → 行动被阻挡
                                            └─ 阻挡者失败 → 行动生效
       ↓ 任一结算产生「失牌」
   influence_lose        （仅当该座位还有 2 张未翻牌时才叫，否则自动翻）
       ↓ 换牌
   exchange_pick         （抽 2 张后选保留；无选择空间时自动）
done
```

7 个相位：`dealing / action_select / action_reaction / block_reaction / influence_lose / exchange_pick / done`。

### 4.2 核心类型

```ts
export type CoupRole = "duke" | "assassin" | "captain" | "ambassador" | "contessa";
export type CoupActionKind =
  | "income" | "foreign_aid" | "coup" | "tax" | "steal" | "assassinate" | "exchange";

export type CoupPhase =
  | "dealing" | "action_select" | "action_reaction" | "block_reaction"
  | "influence_lose" | "exchange_pick" | "done";

export interface CoupCard { id: string; role: CoupRole }

export interface CoupSeatState {
  participantId: string;
  seat: number;
  coins: number;
  cards: CoupCard[];       // 未翻开；顺序即 flip 索引
  revealed: CoupCard[];
  alive: boolean;
  afk: boolean;
  forfeitsInARow: number;
  lastForfeitPhase: CoupPhase | null;
  stats: { claims: number; bluffs: number; challenges: number; hits: number };
}

export interface CoupClaim {
  seat: number;
  action: CoupActionKind;
  role: CoupRole | null;
  target: number | null;
  say: string;
}

export interface CoupReaction {
  seat: number;
  kind: "pass" | "challenge" | "block";
  as: CoupRole | null;
  say: string;
}
```

**结算脚本**（整个设计的支点）：

```ts
type CoupStep =
  | { kind: "gain"; seat: number; coins: number }
  | { kind: "pay"; seat: number; coins: number }
  | { kind: "refund"; seat: number; coins: number }
  | { kind: "transfer"; from: number; to: number; coins: number }
  | { kind: "lose"; seat: number; cause: LossCause }
  | { kind: "prove"; seat: number; role: CoupRole }
  | { kind: "exchange"; seat: number }
  | { kind: "void"; reason: "challenge" | "block" };
```

`pump()` 循环消费脚本：

- `lose` 且该座位还有 **2 张未翻牌** → 停进 `influence_lose`，记 `pendingFlip`，叫该座位；**只有 1 张时自动翻开，不发调用**。
- `exchange` → 抽 `min(2, deck.length)` 张，停进 `exchange_pick`；无选择空间时自动。
- 其余步骤立即执行。

### 4.3 结算算法

**`resolveAction`**

```
challenger := 从 claim.seat 下家起顺时针，第一个 kind==="challenge"
if challenger:
    if actorHolds(claim.seat, claim.role):
        script += lose(challenger, "challenge_lost")
        script += prove(claim.seat, claim.role)
    else:
        script += lose(claim.seat, "challenge_failed")
        if claim.action === "assassinate": script += refund(claim.seat, 3)
        script += void("challenge")
        return pump()
blocker := 顺时针第一个 kind==="block"
if blocker: → block_reaction
else:       → resolveEffect()
```

**`resolveBlock`**

```
challenger := 从 blocker.seat 下家起顺时针，第一个 challenge
if challenger:
    if actorHolds(blocker, blockerRole):
        script += lose(challenger, "challenge_lost")
        script += prove(blocker, blockerRole)
        script += void("block")
    else:
        script += lose(blocker, "challenge_failed")
        → resolveEffect()
else:
    script += void("block")
```

**`resolveEffect`**

| 行动 | 脚本 |
|---|---|
| income | `gain(seat, 1)` |
| foreign_aid | `gain(seat, 2)` |
| coup | `lose(target, "coup")` |
| tax | `gain(seat, 3)` |
| assassinate | `lose(target, "assassinated")` |
| steal | `transfer(target → seat, min(2, target.coins))` |
| exchange | `exchange(seat)` |

脚本清空后 → `alive === 1` 判胜；否则 `turn += 1`，找下一个存活座位。

### 4.4 反应仲裁

**并发收集 + 顺时针优先**：

- `action_reaction` 合法集合：`tax`/`exchange` → challenge；`foreign_aid` → block(duke)，任何存活玩家；`steal` → challenge + block(captain|ambassador)，只有目标；`assassinate` → challenge + block(contessa)，只有目标。
- `block_reaction`：`pass | challenge`，所有存活玩家除阻挡者（含行动者）。
- 多人同时 challenge/block 时，**从被质疑者下家起顺时针第一个**生效。
- 所有反应并发收集，收齐才结算。

### 4.5 不变量（写进测试）

1. 一次行动最多两次质疑，每次只有一人生效。
2. `Σ(未翻牌 + 已翻牌) + deck.length === 15`。
3. 存活座位 `cards + revealed === 2`。
4. 证明成功后手牌数不变。
5. 同一 `(action, seat, turn)` 的重复提交被忽略。
6. 反应未收齐绝不结算。
7. `queueIndex` 指向「已发出的最后一个调用」。

## 5. Prompt 与协议

沿用 `<<<THINK>>>` / `<<<SUBMIT>>>`。

```jsonc
// action_select
{"note": "...", "action": "steal", "target": 3, "say": "你的 2 个金币我看上了。"}
// action_reaction / block_reaction
{"note": "...", "reaction": "challenge", "as": null, "say": "我不信你是公爵。"}
{"note": "...", "reaction": "block", "as": "contessa", "say": "我恰好有伯爵夫人。"}
// influence_lose
{"note": "...", "flip": 0}
// exchange_pick
{"note": "...", "keep": ["c1", "c2"]}
```

**system 三段必写**：

1. 规则正文（blueprint `briefing`，含行动表与阻挡表）。
2. **诚实豁免**：「诈唬是本游戏的合法策略，是规则要求的一部分；你不诈唬等于把胜利让给别人。这里不是现实，是牌桌。」
3. 信息边界：只看得到自己的手牌、公开日志、金币、牌堆剩余；看不到别人的牌与旁白。

**user 段固定给**：自己的牌与金币、四人金币/影响力/存活表、**公开宣称编年史**、当前行动者的宣称与嘴炮、合法动作枚举、账本式提示（「你 3 币，政变需 7 币」）。

### 5.1 前缀缓存（v13 硬约束）

Coup 一局 120–180 次调用，比九人局密，缓存命中直接决定账单。按 AGENTS.md §5「前缀只增不改」：

- **四席 system 逐字节相同**：规则正文、诚实豁免、信息边界写成一份常量；座位号、自己的手牌、当前身份全部挪到 user 尾部。system 第一行不许出现 `1 号` / `2 号`。
- **user 两段**：`stable` = 已结算回合的流水（**累积追加，永不改写**）；`dynamic` = 当前行动者、合法动作枚举、账本提示。
- **`cacheAt` 指向 stable 段末尾**。
- 流水每条压到一行（≤40 字），60 回合约 2400 字，不需要滑动窗口——滑动窗口会改写前缀，等于每轮全价重买。
- 跨回合时，上一轮的 `stable` 必须是下一轮 `stable` 的前缀。

### 5.2 解说 prompt 的缓存

解说每回合调用一次，system（解说规则 + 输出格式）完全一致，`stable` = 历史流水，`dynamic` = 本轮事件。同样标 `cacheAt`。

## 6. Runtime

照抄 `werewolf/runtime.ts` 骨架：

- `apply()` 同步：`reduceCoup` → 写检查点 → `dispatch`。
- `call_seat` 用 `phase:stage` 做 inflight key；反应相位 `callMode: "parallel"`。
- 复用 `callWithRetry` / `openCallWindow` / `openDeltaPump` / `SubmissionStreamParser` / `forfeitReason` / `shouldRetryStall`。
- 检查点 `kind: "coup"`，`recoverCoupMatch` 只补叫 `queue` 里 `pending` 缺失的座位。
- **AFK**：连续 2 次失败 → `afk`，行动按 income、反应按 pass 处理，不再叫。
- **预算**：`maxCalls = min(400, 60 + seats × 80)`；`maxTurns = 60`。
- 模型没交就记 `forfeit`，绝不替它编造宣称。
- **缓存闸门**：`action_reaction` / `block_reaction` 是并发相位。provider 为 `explicit` 缓存模式（Anthropic）时，同一批反应调用过 `src/engine/cache-gate.ts`：第一条放行，其余等它首包到达再发，`holdMs` 3s 兜底；`auto` 模式（DeepSeek / Gemini）不开闸门。不这么做，四条并发会在同一个前缀上各买一次写入费。
- **闸门不许卡死**：等待超时后无条件发车，宁可多付一次写入，也不能让反应窗口停住。

## 7. 赛后评分

平行实现 `coup/review.ts` + `review-runtime.ts`，复用事件名 `review.opened / ballot / verdict`，让前端复用面板外壳。

- **评委**：4 位对局玩家 + 1 位裁判（已确认要加）；`selfWeight: 0`；`judgeVotes: 1`。
  每位被评者收到 3 张玩家票（不含自己）+ 1 张裁判票 = 4 票；4 票样本太小，**不去极值**（`trim: false`）。
- **维度**：

| 维度 | 定义 | 来源 |
|---|---|---|
| `bluff` 诈唬 | 假身份未被识破的比例与关键性 | `stats.bluffs` + 质疑结果 |
| `read` 读人 | 质疑命中率 | `stats.challenges` / `stats.hits` |
| `tempo` 资源 | 金币转化为伤害的效率、政变时机 | 金币轨迹 |
| `poise` 气势 | 嘴炮与心理压迫质量 | `say` 文本 |

- **事实卡**：完整翻牌（最终手牌、每次宣称真伪、质疑结果、金币曲线）。
- **盲化**：不给模型名/厂商名/真名，只给 1–4 号座位。
- **平局**：`trim: false`（每位被评者 4 票，去极值后只剩 2 票，方差过大）。

## 7.5 解说（AI 裁判）

先把「裁判」拆成两件事：

| 类型 | 做什么 | 要不要 |
|---|---|---|
| **裁定型裁判** | 判定谁掉命、质疑是否成立、金币怎么走 | **不要**。规则完全确定，引擎判定；引入模型判定会破坏可复现性（§1 第 1 条）。 |
| **解说型裁判** | 读全牌 + 事件流，用一句话告诉观众「刚才发生了什么、为什么」 | **要**。观众的痛点是看不懂诈唬，这正是解说能补的。 |

### 7.5.1 定位

- 它是**观众侧**的一条独立管线，和赛后评分同族：读全局、不判定、不写游戏 state。
- **绝不进玩家 prompt**。它知道所有人的底牌，任何进入对手 prompt 的路径都会剧透。
- 失败可降级：没有解说，对局照常看。

### 7.5.2 触发

- `coup.turn`（一次行动结算完）→ 一条"这一手发生了什么"。
- `coup.challenge`（质疑结算）→ 一条"谁抓到了谁"。
- `coup.finished` → 一条"整局总结"。

4 人局约 20 回合 → 约 22 次调用，`maxCalls` 之外单独计（`commentary.maxCalls = 30`）。

### 7.5.3 输入与输出

输入（只读）：

- 全部手牌（含已翻开的）
- 金币曲线
- 本轮宣称 + 反应 + 结算结果
- 最近 6 条公开流水

输出（严格 JSON）：

```json
{"text": "B 手里是刺客与大使，没有队长——这一手是诈唬。A 抓住了。"}
```

约束：

- ≤ 90 字，一到两句，不列点、不写小标题。
- 必须点名座位号，不点模型名。
- 可以指出「谁在撒谎」，因为观众也看得到牌。
- 不做价值判断（不说「这步很蠢」），只描述事实与动机。

### 7.5.4 模型选择

- 独立配置 `commentary.modelId`，默认 `null`（关闭）。
- **允许与座位模型重复**（已确认）。LLM 调用是无状态的，同一模型坐在 2 号位不代表它会在解说里"记得"自己的牌——两条管线各自组装 prompt，互不可见。
- 唯一需要留意的是观感：同一模型解说自己那一手，容易写出偏袒的话。解说 prompt 里加一条硬约束：**「你是解说，不是任何一方的辩护人；指出错误与指出诈唬同等重要。」**
- 无可用模型时静默关闭，不影响开局。

### 7.5.5 事件

新增 `coup.commentary`：`{ turn, seat?, text, model, latencyMs }`。
UI 只消费这一条，不做本地生成。

## 8. UI —— 选定：观战台（08）

设计约束：**浅色优先、信息优先、不累眼**。颜色一律走既有语义 token，不新增色值。

### 8.1 布局骨架

```
┌──────────────────────────────────────────────┬──────────────┐
│ CoupHeader  60px                              │              │
├──────────────────────────────────────────────┤ CoupDossier  │
│ CoupCommentary  46px  AI 裁判                  │  List        │
│ CoupStage  grid 3×3                           │  List        │
│   ┌────────────────────────────────────┐      │  392px       │
│   │ row1  152px   [ C 的座位 ]          │      │              │
│   │ row2  1fr     [ W ] [ 中央 ] [ E ]  │      │  四份档案     │
│   │ row3  152px   [ A 的座位 ]          │      │  可滚动       │
│   └────────────────────────────────────┘      │              │
├──────────────────────────────────────────────┴──────────────┤
│ CoupLogStrip  138px   横向流水，最近 7 条                       │
└─────────────────────────────────────────────────────────────┘
```

桌面：`grid-template-columns: minmax(0,1fr) 420px; grid-template-rows: 60px 46px minmax(0,1fr) 138px`；档案栏跨 row 2–3。

舞台内部：`grid-template-columns: minmax(190px,1fr) minmax(0,640px) minmax(190px,1fr); grid-template-rows: 152px minmax(0,1fr) 152px`。座位用 `grid-area` 钉在 `1/2`（北）、`2/1`（西）、`2/3`（东）、`3/2`（南）；中央在 `2/2`。座位容器用 `display:contents` 让四张卡直接成为 grid item。

### 8.2 组件树

```
CoupTable (client)
├─ CoupHeader        局名 / 对局 id / 回合 / 阶段 / 牌堆 / 存活 / 规则按钮
├─ CoupCommentary    AI 裁判解说条（46px，横跨左列）
├─ CoupStage
│  ├─ CoupSeat ×4    模型、金币、影响力、两张牌、上次宣称
│  └─ CoupCenter
│     ├─ CoupClaim      当前宣称（角色、目标、嘴炮、相符标记）
│     ├─ CoupReactions  反应条（pass / challenge / block）
│     └─ CoupOutcome    结算结果（只读，无按钮）
├─ CoupDossierList   四份档案（手牌、金币、宣称史、旁白）
│  └─ CoupDossier ×4
├─ CoupLogStrip      底部横向流水
├─ CoupRules         规则抽屉（440px，覆盖右侧）
└─ CoupReview        终局评分面板（复用 WerewolfReview 的表格骨架）
```

**推演流**并入档案：`CoupDossier` 的"旁白"块显示该座位 `thinking` 的尾部 120 字，按 80ms 节流追加；点「展开」看全文。不单独做一栏，避免和右侧面板抢空间。

### 8.3 字段与数据来源

| 区块 | 字段 | 来源 |
|---|---|---|
| Header | 回合 / 阶段 / 牌堆 / 存活 | `state.turn` / `state.phase` / `state.deck.length` / `alive` |
| Seat | 模型名、厂商 | `participants.model_json` |
| Seat | 金币（大字）、影响力（两格方块） | `seat.coins` / `seat.cards.length` |
| Seat | 两张牌：角色图标 + 名字；已翻牌加删除线 | `seat.cards` / `seat.revealed` |
| Seat | 本次/上次宣称 + 「相符 / 不符」标记 | `state.claim`（行动者）或 `seat.claims.at(-1)` |
| Claim | 角色、行动、目标、嘴炮 | `state.claim` |
| Reactions | 三个 chip：座位号、模型、结论 | `state.reactions` |
| Dossier | 金币、命、距政变还差几枚 | `7 - seat.coins` |
| Dossier | 宣称史（最近 3 条）+ 质疑记录 | `seat.claims` / `seat.challenges` |
| Dossier | 诚实 / 诈唬 / 沉默标签 | 最近一条带身份的宣称真伪 |
| LogStrip | 最近 7 条事件文本 | `state.publicLog` 尾部 |
| Dossier | 两张手牌（大卡，带能力说明） | `seat.cards` / `seat.revealed` |
| Commentary | 解说文本 | `coup.commentary` 事件 |
| Rules | 七种行动 / 五种身份 / 六步结算 | 静态规则表，从 blueprint `briefing` 生成 |

**标记语义**：只有「角色行动」才判相符/不符。`income` / `foreign_aid` / `coup` 没有身份，标记位显示「—」而不是「相符」。这是 demo 里修过的一个逻辑错误，必须带进实现。

**观众可见性**：牌面永远正面显示（`coup.dealt` 事件带全部手牌）；模型 prompt 只看自己的。二者不共用同一个视图函数，避免泄漏。

### 8.4 事件 → 视图映射（`lib/coup-frame.ts` 纯函数）

| 事件 | 视图变化 |
|---|---|
| `match.created` | 建 4 个座位骨架 |
| `coup.dealt` | 填充手牌（观众侧正面） |
| `phase.changed` | 顶栏阶段、当前座位高亮 |
| `seat.thinking.delta` | 对应档案旁白追加（`channel === "note"` 才进 UI） |
| `coup.action` | 中央 claim 卡、座位「本次宣称」 |
| `coup.reaction` | 反应条追加 chip |
| `coup.challenge` | claim 卡下方插入结算行 |
| `coup.block` | 阻挡者座位加标记 |
| `coup.lost` | 座位翻牌、影响力 −1 |
| `coup.exchange` | 流水追加一条 |
| `coup.turn` | 流水追加、回合 +1 |
| `coup.commentary` | 解说条替换文本 |
| `coup.finished` | 终局横幅 + 全牌翻开 |
| `review.*` | 评分面板 |
| `anomaly` | 顶栏红点 + 流水置顶 |
| `state.updated` | 暂停态横幅 |

### 8.5 颜色映射（不新增 token）

demo 的色值已与 `globals.css` 的 light 主题几乎一致，直接映射：

| demo 变量 | demo 值 | 项目 token | light 值 |
|---|---|---|---|
| `--bg` | `#f3f1ec` | `--ink-0` | `#f4f2ec` |
| `--panel` | `#ffffff` | `--ink-1` | `#fffdf8` |
| `--panel-2` | `#fbfaf7` | `--ink-2` | `#faf7ef` |
| `--line` | `#e2ded5` | `--line` | `#e3ded1` |
| `--line-2` | `#cbc6ba` | `--line-strong` | `#cfc8b6` |
| `--ink` | `#1b1a17` | `--fg` | `#1b1a17` |
| `--ink-2` | `#514f48` | `--fg-dim` | `#57534a` |
| `--ink-3` | `#86827a` | `--fg-faint` | `#8a8477` |
| `--gold` | `#8f6b1c` | `--amber` | `#a8630f` |
| `--red` | `#ad3a2d` | `--blood` | `#c23a2c` |
| `--green` | `#2b6d4d` | `--jade` | `#0b8a68` |

夜间模式自动落到 dark token，层级关系不变。默认主题建议设为日间（`data-theme="light"`），因为评审结论是浅色更耐看。

### 8.6 字号与节奏

| 元素 | 字号 | 字重 |
|---|---|---|
| 模型名（座位） | 14.5px | 600 |
| 模型名（档案） | 14.5px | 600 |
| 金币数字 | 24–26px | 600（等宽） |
| 角色名（座位牌） | 12.5px | 500 |
| 宣称主句 | 17px | 600 |
| 流水正文 | 12px | 400 |
| 档案旁白 | 12.5px | 400 斜体 |

行高统一 1.6–1.8。正文最小 12px，不再往下压。

### 8.7 响应式

| 断点 | 布局 |
|---|---|
| ≥1280 | 三区（舞台 + 392 档案 + 138 流水） |
| 1024–1280 | 档案 330，舞台中央列 540 |
| <1024 | 纵向堆叠：舞台 / 档案 260 / 流水 130 |
| <720 | 座位卡改为横向滚动，东西两座隐藏 |

### 8.8 交互

- **点座位卡** → 档案栏滚动到对应档案并高亮 1.2s。
- **点流水条目** → 若该条对应某个座位，同上。
- **点档案旁白** → 展开 / 收起全文。
- 暂停 / 继续 / 中止 → 复用现有 `/intervene` 与 `/abort`。
- **没有「结算」按钮**。demo 里的那颗按钮是演示道具——真实对局由最后一份反应触发的 reducer 自动结算，UI 只消费事件。实现时删除。

### 8.9 状态与空态

- **加载中**：骨架屏，四张空座位卡，不闪。
- **未发牌**：座位卡显示「等待发牌」，金币 0。
- **对局中断**（`live: false`）：顶栏显示「已中断」+ 「继续对局」按钮（复用 `recover`）。
- **终局**：全部手牌翻正，赢家座位加边框，底部流水冻结，评分面板从下方展开。

### 8.10 动画

只做位移与边框，不碰 opacity 关键帧（合成器不推进时会永久停在 0）。

| 场景 | 实现 |
|---|---|
| 宣称出现 | `border-color` transition 150ms |
| 反应 chip 出现 | `transform: translateY(4px) → 0`，120ms |
| 翻牌 | `transform: rotateY(90deg)` 两段 160ms；或直接切换（若成本高） |
| 座位高亮 | `box-shadow` transition 200ms |

### 8.11 性能

- `thinking` delta 沿用 `ARENA_FLUSH_MS`（80ms）节流。
- 座位卡 `memo`，只重建 `claim` / `reactions` / 该座位 `thinking` 变化的那一个。
- 流水保留最近 80 条，超出丢头部；DOM 只渲染最近 7 条 + 横向滚动。
- 批量刷新用 `setTimeout(16)`，不用 `requestAnimationFrame`。

## 9. 接线与迁移

| 文件 | 改动 |
|---|---|
| `src/engine/types.ts` | `GameKind` 加 `"coup"`；`EventType` 加 `coup.dealt / action / reaction / challenge / block / lost / exchange / turn / commentary / finished` |
| `src/engine/game.ts` | `parseAnyBlueprint` 分流；`isCoupBlueprint`；`blueprintMeta` |
| `src/engine/runtime.ts` | `startMatch` / `recoverMatch` / `intervene` 分流 |
| `src/db/repo.ts` | `kind` 派生加 `coup` |
| `src/lib/pin.ts` | 三值 kind；路径 `/coup/:id` |
| `src/components/MatchLauncher.tsx` | 第三种 kind；4 座位选择器 |
| `src/app/page.tsx`、`matches/page.tsx`、`MatchPin.tsx` | 链接三元改三值 |
| `src/app/coup/[matchId]/page.tsx` | 新页面 |
| `rulesets/coup-four.md` + `.blueprint.json` | 内置规则 |
| `AGENTS.md` | §0/§1/§2/§3/§9/§11 |

**不递增 `SCHEMA_VERSION`**：不加列、不加表；检查点走既有 `match_checkpoints(kind, payload_json)`。

## 10. 测试矩阵

| 文件 | 覆盖 |
|---|---|
| `tests/coup-deal.test.ts` | 15 张牌守恒、同 seed 重放一致、4 人各 2 张 |
| `tests/coup-reduce.test.ts` | 七种行动结算、10 币强制政变、金币不足拒绝、目标非法拒绝、回合上限 |
| `tests/coup-challenge.test.ts` | **质疑退钱 / 阻挡不退钱**、双重危险、顺时针优先、证明后洗回抽新、同窗口只一人质疑、重复提交忽略 |
| `tests/coup-prompt.test.ts` | 看不到对手手牌与旁白、合法动作枚举、诚实豁免段存在、**四席 system 逐字节相同**、`cacheAt` 落在编年史末尾、新回合只追加不改写 |
| `tests/coup-recover.test.ts` | 并发相位只补欠动作、已交卷不重叫、`queueIndex` 不变量 |
| `tests/coup-review.test.ts` | 事实卡真伪标注、盲化、4 票聚合、自评不计入 |
| `tests/coup-commentary.test.ts` | 解说 prompt 不含模型名、只读全牌、失败不阻塞、≤90 字截断 |
| `tests/coup-frame.test.ts` | 事件 → 视图还原、终局翻牌 |

## 11. 边界与失败模式

| 风险 | 处置 |
|---|---|
| 模型不肯撒谎 | system 写死「诈唬是规则」，要求把意图写进观众旁白；`coup-prompt.test.ts` 断言这段存在 |
| 模型算不清金币 | 每次 prompt 重算「你有 X 币 / 政变需 7」，并枚举合法动作 |
| 反应窗口慢 | 4 人局每轮 3 个并发调用；一局约 120–180 次，`maxCalls: 380` 兜底 |
| 牌堆抽空 | `draw()` 返回 `null` 时能抽几张抽几张；`prove` 强制先洗回再抽 |
| 进程崩溃 | 检查点写在 `dispatch` 之前 |
| 同模型坐两席 | 要求 4 个不同模型，否则报错 |
| 并发反应各买一次缓存写入 | 显式缓存模式下过闸门；等待超时照样发车 |
| 编年史越写越长撑爆上下文 | 每条压到一行；超过 60 回合本来就会判胜 |

## 12. 分阶段交付

1. **引擎核心**：`types / blueprint / deal / reduce` + 前三个测试。
2. **Prompt + Runtime + 接线**：能开一局、落事件、续跑。
3. **牌桌 UI**：`coup-frame` + 选定方案（含规则抽屉、手牌大卡）。
4. **解说**：`commentary` 管线（可独立开关，不影响 1–3）。
5. **赛后评分**：`review` + `review-runtime`。
6. **收尾**：`rulesets/coup-four.*`、`AGENTS.md`、README、导出菜单。

## 13. 假设

1. 4 人桌固定，不做人数配置。
2. 4 个座位要求 4 个不同模型，演练体可填。
3. 不做 Inquisitor / 2 人变体 / 扩牌。
4. 评分评委是 4 位玩家 + 1 位裁判；裁判票等权（`judgeVotes: 1`），不去极值。
5. 回合上限 60，超限按（影响力 → 金币）判胜。
6. `say` 进公开日志与对手 prompt，上限 200 字。
7. 观众可见全部手牌；模型只可见自己的。

---

## 附：设计稿索引

预览：`tmp/coup-demos/index.html`（直接双击打开）。共享数据：`tmp/coup-demos/data.js`。
被弃用的深色稿在 `tmp/coup-demos/_archive/`，不作为选项。

---

## 14. v2 修订：让没玩过的人看懂（2026-10）

第一版把「上帝视角」做成了牌面展示，但观众读不出叙事。实测一局 8 分钟产生 4000+ 条
`seat.thinking.delta`，其中全部是 `channel: "reason"` 的原生推理（英文、复读 prompt），
而真正的旁白 `note` 一条也没有；底部流水只在质疑/掉命时写，金币与手牌在偷窃、收入、
亮牌换牌后完全不更新；解说默认关闭，且触发时 `state.claim` 已被清空。

v2 的修订：

1. **一手是叙事单位。** `src/engine/coup/turn.ts` 把 `coup.action / reaction / block /
   challenge / lost / coins / forfeit` 折叠成 `CoupTurnRecord`；UI 与解说共用同一份事实卡。
   `coup.turn` 是上一手的封存点，`coup.finished` 兜底封存最后一手。
2. **事实层永远有。** 谁→谁、是否持有那张牌、谁掉了什么，全部由 `describeTurn()` 生成，
   不依赖模型；解说只是第二层动机。
3. **原始推理不进事件流。** `channel === "reason"` 不落库、不广播；观众只看 `note`。
   事件量从约 4000/局降到约 120/局。
4. **金币与手牌必须发事件。** 新增 `coup.coins`（带 `before`）与 `coup.hand`（亮牌换牌后）。
5. **弃权必须可见。** 新增 `coup.forfeit`；`coup.action / coup.reaction` 带 `forfeit` 与
   `anomalies`。引擎把弃权回落成「收入 / 放过」时，UI 必须写明这是弃权，不能伪装成选择。
6. **解说是每手一条的结构化三段。** `coup.settled` 不存在；runtime 用 `CoupTurnRecord`
   在 `coup.turn / coup.finished` 触发，prompt 里带上每个反应者的原话与「是否诈唬」，
   输出 2–3 句、≤160 字。
7. **一号坑：`Number(null) === 0`。** `coerceCoupMove` 曾把 `"target": null` 变成 0，
   导致所有「征税」被判成带了目标而整手作废、回落收入；同时目标没有做 1-based → 0-based。
   现在 `null / "" / 0` 都是「无目标」，数字按 1-based 减一，中文动作名与身份名也做归一。

界面随之改为：中央「这一手」卡（宣称 / 真伪 / 台词 / 回应 / 结果 / 自述）、四座的目标高亮、
顶栏「轮到谁 / 等谁表态」、底部回合时间线（每手一张卡 + 解说）、右侧档案显示自述与诈唬计数。
