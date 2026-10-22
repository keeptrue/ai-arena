import { getDb, nid } from "./client";
import {
  DEFAULT_PROVIDERS,
  DROPPED_TABLES,
  LEGACY_TABLES,
  MOCK_MODELS,
  PROMPT_TABLE_SQL,
  SCHEMA_SQL,
  SCHEMA_VERSION,
} from "./schema";
import { reasoningStyleFor } from "@/engine/reasoning";
import type {
  Blueprint,
  EventType,
  MatchState,
  ModelCard,
  ModelSnapshot,
  ParticipantState,
  ProviderKind,
  ReasoningEffort,
  ReasoningStyle,
  RoundRecord,
  Ruleset,
  TeamState,
} from "@/engine/types";

/* ── rows ──────────────────────────────────────────────────────────── */

export interface ProviderRow {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled: boolean;
}

export interface ModelRow {
  id: string;
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
  baseUrl: string;
  modelId: string;
  display: string;
  temperature: number;
  supportsReasoning: boolean;
  reasoningEffort: ReasoningEffort | null;
  thinkingBudget: number | null;
  reasoningStyle: ReasoningStyle | null;
  card: ModelCard | null;
  inContenderPool: boolean;
  inJudgePool: boolean;
  enabled: boolean;
  contextWindow: number | null;
  fetchedAt: number;
}

export interface MatchSummary {
  id: string;
  rulesetId: string;
  rulesetName: string;
  seed: string;
  status: string;
  format: string;
  winnerTeamId: string | null;
  winnerTeamName: string | null;
  endReason: string | null;
  createdAt: number;
  finishedAt: number | null;
  rounds: number;
  callsUsed: number;
  tokensUsed: number;
  teams: Array<{ id: string; name: string; color: string; total: number }>;
}

export interface RulesetRow extends Ruleset {}

/* ── schema bootstrap ──────────────────────────────────────────────── */

function tableExists(name: string): boolean {
  const row = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

/**
 * The numeric-combat era stored `games` / different columns. Development data has
 * no value, so the upgrade path is destructive and explicit rather than clever.
 */
export function migrateIfNeeded(): { rebuilt: boolean; notes: string[] } {
  const db = getDb();
  const notes: string[] = [];

  // v1 → v2: the numeric-combat era shared no useful rows; rebuild from scratch.
  const legacy = LEGACY_TABLES.filter((t) => tableExists(t));
  if (legacy.length > 0) {
    db.exec("PRAGMA foreign_keys = OFF");
    for (const t of [...legacy, "judgements", "events", "submissions", "participants", "teams", "matches", "rulesets"]) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    db.exec(SCHEMA_SQL);
    db.exec("PRAGMA foreign_keys = ON");
    return { rebuilt: true, notes: ["legacy schema dropped"] };
  }

  // v3 → v4: personas removed. SQLite cannot drop the NOT NULL column in place,
  // so rebuild the participants table and carry every row over.
  const columns = db.prepare("PRAGMA table_info(participants)").all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "persona_json")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE participants_v4 (
        id          TEXT PRIMARY KEY,
        match_id    TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        team_id     TEXT NOT NULL,
        seat        INTEGER NOT NULL,
        model_json  TEXT NOT NULL,
        score_total REAL NOT NULL DEFAULT 0,
        forfeits    INTEGER NOT NULL DEFAULT 0,
        UNIQUE(match_id, seat)
      );
      INSERT INTO participants_v4 (id, match_id, team_id, seat, model_json, score_total, forfeits)
        SELECT id, match_id, team_id, seat, model_json, score_total, forfeits FROM participants;
      DROP TABLE participants;
      ALTER TABLE participants_v4 RENAME TO participants;
    `);
    db.exec("PRAGMA foreign_keys = ON");
    notes.push("participants rebuilt without persona_json");
  }

  // v4 → v5: reasoning strength per model. Additive, so plain ALTERs are enough.
  const modelColumns = (db.prepare("PRAGMA table_info(models)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  const additions: Array<[string, string]> = [
    ["reasoning_effort", "TEXT"],
    ["thinking_budget", "INTEGER"],
    ["card_json", "TEXT"],
  ];
  for (const [column, type] of additions) {
    if (!modelColumns.includes(column)) {
      db.exec(`ALTER TABLE models ADD COLUMN ${column} ${type}`);
      notes.push(`models + ${column}`);
    }
  }

  // v5 → v6: the referee is frozen when the match is created, not only when the
  // first verdict lands. Additive, so existing matches keep working (their
  // judge_json stays NULL and the read path falls back to `judgements`).
  const matchColumns = (db.prepare("PRAGMA table_info(matches)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (!matchColumns.includes("judge_json")) {
    db.exec("ALTER TABLE matches ADD COLUMN judge_json TEXT");
    notes.push("matches + judge_json");
  }

  // v5 → v6: global prompt overrides. Purely additive; existing databases just
  // gain an empty table and fall back to the built-in templates.
  if (!tableExists("prompt_templates")) {
    db.exec(PROMPT_TABLE_SQL);
    notes.push("prompt_templates created");
  }

  // v6 → v7: the per-model output ceiling is gone. Adapters never send
  // `max_tokens`, so an old database keeps the column as dead weight (nothing
  // reads it) while new databases are created without it.
  const modelColumnsV7 = (db.prepare("PRAGMA table_info(models)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  if (modelColumnsV7.includes("max_tokens")) notes.push("models.max_tokens 已退役");

  for (const t of DROPPED_TABLES) {
    if (tableExists(t)) {
      db.exec(`DROP TABLE IF EXISTS ${t}`);
      notes.push(`dropped ${t}`);
    }
  }

  return { rebuilt: false, notes };
}

export function ensureSeedData(): void {
  const db = getDb();
  migrateIfNeeded();

  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  if (version?.value === String(SCHEMA_VERSION)) return;

  const now = Date.now();
  const providerCount = (db.prepare("SELECT COUNT(*) AS n FROM providers").get() as { n: number }).n;

  // Presets are a starting point, not a fixture: once the user has any provider of
  // their own we stop re-adding the ones they deleted.
  if (providerCount === 0) {
    const insP = db.prepare(
      "INSERT OR IGNORE INTO providers (id, name, kind, base_url, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    );
    for (const p of DEFAULT_PROVIDERS) insP.run(p.id, p.name, p.kind, p.baseUrl, now);
  }

  const hasMock = !!db.prepare("SELECT id FROM providers WHERE id='mock'").get();
  if (hasMock) {
    const insMock = db.prepare(
      `INSERT OR IGNORE INTO models
        (id, provider_id, model_id, display, temperature, supports_reasoning,
         in_contender_pool, in_judge_pool, enabled, context_window, fetched_at)
       VALUES (?, ?, ?, ?, 0.9, 0, 1, 1, 1, NULL, ?)`,
    );
    for (const m of MOCK_MODELS) insMock.run(m.id, m.providerId, m.modelId, m.display, now);
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );
}

/* ── providers ─────────────────────────────────────────────────────── */

export function listProviders(): ProviderRow[] {
  return (getDb().prepare("SELECT * FROM providers ORDER BY created_at").all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as ProviderKind,
    baseUrl: r.base_url,
    enabled: !!r.enabled,
  }));
}

export function getProvider(id: string): ProviderRow | null {
  return listProviders().find((p) => p.id === id) ?? null;
}

export function upsertProvider(input: {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled?: boolean;
}): string {
  const db = getDb();
  const id = input.id ?? nid("prov");
  const exists = db.prepare("SELECT id FROM providers WHERE id = ?").get(id);
  if (exists) {
    db.prepare("UPDATE providers SET name=?, kind=?, base_url=?, enabled=? WHERE id=?").run(
      input.name,
      input.kind,
      input.baseUrl,
      input.enabled === false ? 0 : 1,
      id,
    );
  } else {
    db.prepare(
      "INSERT INTO providers (id, name, kind, base_url, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, input.name, input.kind, input.baseUrl, input.enabled === false ? 0 : 1, Date.now());
  }
  return id;
}

export function deleteProvider(id: string): void {
  getDb().prepare("DELETE FROM providers WHERE id = ?").run(id);
}

/* ── models ────────────────────────────────────────────────────────── */

const MODEL_SELECT = `
  SELECT m.*, p.name AS provider_name, p.kind AS provider_kind, p.base_url AS provider_base
  FROM models m JOIN providers p ON p.id = m.provider_id
`;

function toModelRow(r: any): ModelRow {
  const card = parseCard(r.card_json);
  const providerKind = r.provider_kind as ProviderKind;
  return {
    id: r.id,
    providerId: r.provider_id,
    providerName: r.provider_name,
    providerKind,
    baseUrl: r.provider_base ?? "",
    modelId: r.model_id,
    display: r.display,
    temperature: r.temperature,
    supportsReasoning: !!r.supports_reasoning,
    reasoningEffort: (r.reasoning_effort ?? null) as ReasoningEffort | null,
    thinkingBudget: r.thinking_budget ?? null,
    reasoningStyle: reasoningStyleFor({ kind: providerKind, card }),
    inContenderPool: !!r.in_contender_pool,
    inJudgePool: !!r.in_judge_pool,
    enabled: !!r.enabled,
    contextWindow: r.context_window ?? null,
    fetchedAt: r.fetched_at,
    card,
  };
}

function parseCard(raw: unknown): ModelCard | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as ModelCard;
  } catch {
    return null;
  }
}

export function listModels(): ModelRow[] {
  return (getDb().prepare(`${MODEL_SELECT} ORDER BY p.created_at, m.display`).all() as any[]).map(toModelRow);
}

export function getModelRow(id: string): ModelRow | null {
  const r = getDb().prepare(`${MODEL_SELECT} WHERE m.id = ?`).get(id) as any;
  return r ? toModelRow(r) : null;
}

export function snapshotModel(modelRowId: string): ModelSnapshot {
  const row = getModelRow(modelRowId);
  if (!row) throw new Error(`model not found: ${modelRowId}`);
  const provider = getProvider(row.providerId);
  return {
    providerId: row.providerId,
    providerName: provider?.name ?? row.providerName,
    kind: provider?.kind ?? row.providerKind,
    baseUrl: provider?.baseUrl ?? "",
    modelId: row.modelId,
    display: row.display,
    temperature: row.temperature,
    supportsReasoning: row.supportsReasoning,
    reasoningEffort: row.reasoningEffort,
    thinkingBudget: row.thinkingBudget,
    reasoningStyle: row.reasoningStyle,
    supportsTemperature: row.card?.supportsTemperature !== false,
  };
}

export function updateModel(
  id: string,
  patch: Partial<{
    display: string;
    temperature: number;
    supportsReasoning: boolean;
    reasoningEffort: ReasoningEffort | null;
    thinkingBudget: number | null;
    card: ModelCard | null;
    inContenderPool: boolean;
    inJudgePool: boolean;
    enabled: boolean;
  }>,
): void {
  const current = getModelRow(id);
  if (!current) return;

  // Nullable knobs need explicit presence checks: `??` would silently keep the old value.
  const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key);
  const supportsReasoning = patch.supportsReasoning ?? current.supportsReasoning;
  const card = has("card") ? (patch.card ?? null) : current.card;
  const effort = has("reasoningEffort") ? (patch.reasoningEffort ?? null) : current.reasoningEffort;
  const budget = has("thinkingBudget") ? (patch.thinkingBudget ?? null) : current.thinkingBudget;

  getDb()
    .prepare(
      `UPDATE models SET display=?, temperature=?, supports_reasoning=?,
        reasoning_effort=?, thinking_budget=?, card_json=?,
        in_contender_pool=?, in_judge_pool=?, enabled=? WHERE id=?`,
    )
    .run(
      patch.display ?? current.display,
      patch.temperature ?? current.temperature,
      supportsReasoning ? 1 : 0,
      effort,
      budget,
      card ? JSON.stringify(card) : null,
      (patch.inContenderPool ?? current.inContenderPool) ? 1 : 0,
      (patch.inJudgePool ?? current.inJudgePool) ? 1 : 0,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      id,
    );
}

/** Upserts the models a provider just reported. Existing pool choices are preserved. */
export function syncProviderModels(
  providerId: string,
  models: Array<{ id: string; display: string; contextWindow?: number | null }>,
  cards?: Map<string, ModelCard | null>,
): number {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO models
      (id, provider_id, model_id, display, temperature, supports_reasoning,
       reasoning_effort, thinking_budget, card_json,
       in_contender_pool, in_judge_pool, enabled, context_window, fetched_at)
     VALUES (?, ?, ?, ?, 0.9, ?, NULL, NULL, ?, 1, 1, 1, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       display = excluded.display,
       context_window = COALESCE(excluded.context_window, models.context_window),
       card_json = COALESCE(excluded.card_json, models.card_json),
       supports_reasoning = MAX(models.supports_reasoning, excluded.supports_reasoning),
       fetched_at = excluded.fetched_at`,
  );
  for (const m of models) {
    const card = cards?.get(m.id) ?? null;
    stmt.run(
      nid("m"),
      providerId,
      m.id,
      m.display,
      card?.reasoning ? 1 : 0,
      card ? JSON.stringify(card) : null,
      m.contextWindow ?? card?.contextWindow ?? null,
      now,
    );
  }
  return models.length;
}

/* ── prompt overrides ──────────────────────────────────────────────── */

export interface PromptOverrideRow {
  key: string;
  body: string;
  updatedAt: number;
}

export function listPromptOverrides(): PromptOverrideRow[] {
  return (getDb().prepare("SELECT * FROM prompt_templates ORDER BY key").all() as any[]).map((r) => ({
    key: r.key,
    body: r.body,
    updatedAt: r.updated_at,
  }));
}

export function getPromptOverride(key: string): string | null {
  const row = getDb().prepare("SELECT body FROM prompt_templates WHERE key=?").get(key) as
    | { body: string }
    | undefined;
  return row?.body ?? null;
}

export function setPromptOverride(key: string, body: string): void {
  getDb()
    .prepare(
      `INSERT INTO prompt_templates (key, body, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`,
    )
    .run(key, body, Date.now());
}

/** Removing the row is the reset: the built-in template takes over again. */
export function clearPromptOverride(key: string): void {
  getDb().prepare("DELETE FROM prompt_templates WHERE key=?").run(key);
}

/* ── rulesets ──────────────────────────────────────────────────────── */

function toRuleset(r: any): RulesetRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    sourceMd: r.source_md,
    blueprint: JSON.parse(r.blueprint_json) as Blueprint,
    blueprintHash: r.blueprint_hash,
    compiledAt: r.compiled_at ?? null,
    compiledBy: r.compiled_by ?? null,
    enabled: !!r.enabled,
  };
}

export function listRulesets(): RulesetRow[] {
  return (getDb().prepare("SELECT * FROM rulesets ORDER BY created_at").all() as any[]).map(toRuleset);
}

export function getRulesetById(id: string): RulesetRow | null {
  const r = getDb().prepare("SELECT * FROM rulesets WHERE id=?").get(id) as any;
  return r ? toRuleset(r) : null;
}

export function getRulesetBySlug(slug: string): RulesetRow | null {
  const r = getDb().prepare("SELECT * FROM rulesets WHERE slug=?").get(slug) as any;
  return r ? toRuleset(r) : null;
}

export function upsertRuleset(input: {
  id?: string;
  slug: string;
  name: string;
  sourceMd: string;
  blueprint: Blueprint;
  blueprintHash: string;
  compiledAt: number | null;
  compiledBy: string | null;
}): string {
  const db = getDb();
  const existing = getRulesetBySlug(input.slug);
  const id = existing?.id ?? input.id ?? nid("rule");
  const json = JSON.stringify(input.blueprint);
  if (existing) {
    db.prepare(
      `UPDATE rulesets SET name=?, source_md=?, blueprint_json=?, blueprint_hash=?,
        compiled_at=?, compiled_by=? WHERE id=?`,
    ).run(input.name, input.sourceMd, json, input.blueprintHash, input.compiledAt, input.compiledBy, id);
  } else {
    db.prepare(
      `INSERT INTO rulesets (id, slug, name, source_md, blueprint_json, blueprint_hash,
        compiled_at, compiled_by, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, input.slug, input.name, input.sourceMd, json, input.blueprintHash, input.compiledAt, input.compiledBy, Date.now());
  }
  return id;
}

/* ── matches ───────────────────────────────────────────────────────── */

export function createMatch(input: {
  id: string;
  rulesetId: string;
  blueprint: Blueprint;
  seed: string;
  format: string;
  budget: { maxCalls: number; maxTokens: number };
  judge: ModelSnapshot | null;
  teams: Array<{ id: string; idx: number; name: string; color: string }>;
  participants: Array<{ id: string; teamId: string; seat: number; model: ModelSnapshot }>;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO matches (id, ruleset_id, blueprint_snapshot_json, seed, status, format, budget_json, judge_json, created_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.rulesetId,
    JSON.stringify(input.blueprint),
    input.seed,
    input.format,
    JSON.stringify(input.budget),
    input.judge ? JSON.stringify(input.judge) : null,
    Date.now(),
  );

  const insTeam = db.prepare(
    "INSERT INTO teams (id, match_id, idx, name, color) VALUES (?, ?, ?, ?, ?)",
  );
  for (const t of input.teams) insTeam.run(t.id, input.id, t.idx, t.name, t.color);

  const insPart = db.prepare(
    "INSERT INTO participants (id, match_id, team_id, seat, model_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const p of input.participants)
    insPart.run(p.id, input.id, p.teamId, p.seat, JSON.stringify(p.model));
}

export function setMatchStatus(
  id: string,
  status: string,
  extra?: { winnerTeamId?: string | null; endReason?: string | null },
): void {
  const db = getDb();
  if (extra) {
    db.prepare("UPDATE matches SET status=?, winner_team_id=?, end_reason=?, finished_at=? WHERE id=?").run(
      status,
      extra.winnerTeamId ?? null,
      extra.endReason ?? null,
      Date.now(),
      id,
    );
  } else {
    db.prepare("UPDATE matches SET status=? WHERE id=?").run(status, id);
  }
}

export function updateMatchUsage(id: string, calls: number, tokens: number): void {
  getDb().prepare("UPDATE matches SET calls_used=?, tokens_used=? WHERE id=?").run(calls, tokens, id);
}

export function updateTeamTotals(matchId: string, teams: TeamState[]): void {
  const stmt = getDb().prepare("UPDATE teams SET total_score=?, forfeits=? WHERE id=? AND match_id=?");
  for (const t of teams) stmt.run(t.totalScore, t.forfeits, t.id, matchId);
}

export function getMatch(id: string): MatchSummary | null {
  const db = getDb();
  const r = db.prepare(
    `SELECT m.*, r.name AS ruleset_name FROM matches m LEFT JOIN rulesets r ON r.id = m.ruleset_id WHERE m.id = ?`,
  ).get(id) as any;
  if (!r) return null;
  const rounds = db.prepare("SELECT COUNT(*) AS n FROM events WHERE match_id=? AND type='round.closed'").get(id) as { n: number };
  const teamRows = db.prepare("SELECT * FROM teams WHERE match_id=? ORDER BY idx").all(id) as any[];
  const winner = teamRows.find((t) => t.id === r.winner_team_id);
  return {
    id: r.id,
    rulesetId: r.ruleset_id,
    rulesetName: r.ruleset_name ?? "（规则已删除）",
    seed: r.seed,
    status: r.status,
    format: r.format,
    winnerTeamId: r.winner_team_id,
    winnerTeamName: winner?.name ?? null,
    endReason: r.end_reason,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    rounds: rounds.n,
    callsUsed: r.calls_used,
    tokensUsed: r.tokens_used,
    teams: teamRows.map((t) => ({ id: t.id, name: t.name, color: t.color, total: t.total_score })),
  };
}

export function listMatches(limit = 40): MatchSummary[] {
  const rows = getDb().prepare("SELECT id FROM matches ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ id: string }>;
  return rows.map((r) => getMatch(r.id)!).filter(Boolean);
}

export function getMatchRoster(matchId: string): {
  teams: Array<{ id: string; idx: number; name: string; color: string }>;
  participants: Array<{ id: string; teamId: string; seat: number; model: ModelSnapshot }>;
} {
  const db = getDb();
  const teams = (db.prepare("SELECT * FROM teams WHERE match_id=? ORDER BY idx").all(matchId) as any[]).map((t) => ({
    id: t.id,
    idx: t.idx,
    name: t.name,
    color: t.color,
  }));
  const participants = (db.prepare("SELECT * FROM participants WHERE match_id=? ORDER BY seat").all(matchId) as any[]).map((p) => ({
    id: p.id,
    teamId: p.team_id,
    seat: p.seat,
    model: JSON.parse(p.model_json) as ModelSnapshot,
  }));
  return { teams, participants };
}

/**
 * The frozen judge snapshot for a match. New matches write it at creation; matches
 * from before schema v6 only have it in their strongest recorded judgement.
 */
export function getMatchJudge(matchId: string): ModelSnapshot | null {
  const db = getDb();
  const frozen = db.prepare("SELECT judge_json FROM matches WHERE id=?").get(matchId) as
    | { judge_json?: string | null }
    | undefined;
  const recorded =
    frozen?.judge_json ??
    (
      db
        .prepare("SELECT judge_json FROM judgements WHERE match_id=? ORDER BY round DESC LIMIT 1")
        .get(matchId) as { judge_json?: string } | undefined
    )?.judge_json;
  if (!recorded) return null;
  try {
    return JSON.parse(recorded) as ModelSnapshot;
  } catch {
    return null;
  }
}

export function markOrphansInterrupted(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM matches WHERE status='running'").all() as Array<{ id: string }>;
  for (const r of rows) db.prepare("UPDATE matches SET status='interrupted' WHERE id=?").run(r.id);
  return rows.map((r) => r.id);
}

/* ── submissions ───────────────────────────────────────────────────── */

export function saveSubmission(
  matchId: string,
  round: number,
  teamId: string,
  submission: {
    participantId: string;
    status: string;
    thinking: string;
    content: Record<string, unknown>;
    usage: unknown;
    latencyMs: number;
  },
): void {
  getDb()
    .prepare(
      `INSERT INTO submissions
        (id, match_id, round, team_id, participant_id, status, thinking, content_json, usage_json, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id, round, participant_id) DO UPDATE SET
         status=excluded.status, thinking=excluded.thinking, content_json=excluded.content_json,
         usage_json=excluded.usage_json, latency_ms=excluded.latency_ms`,
    )
    .run(
      nid("sub"),
      matchId,
      round,
      teamId,
      submission.participantId,
      submission.status,
      submission.thinking ?? "",
      JSON.stringify(submission.content ?? {}),
      JSON.stringify(submission.usage ?? {}),
      submission.latencyMs ?? 0,
      Date.now(),
    );
}

export function listSubmissions(matchId: string, round: number): Array<{
  participantId: string;
  teamId: string;
  status: string;
  content: Record<string, unknown>;
}> {
  return (getDb()
    .prepare("SELECT * FROM submissions WHERE match_id=? AND round=?")
    .all(matchId, round) as any[]).map((r) => ({
    participantId: r.participant_id,
    teamId: r.team_id,
    status: r.status,
    content: JSON.parse(r.content_json) as Record<string, unknown>,
  }));
}

/* ── events ────────────────────────────────────────────────────────── */

export function appendEvent(matchId: string, event: { seq: number; ts: number; type: string; seat?: number; teamId?: string; payload: unknown }): void {
  getDb()
    .prepare("INSERT INTO events (match_id, seq, ts, type, seat, team_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(matchId, event.seq, event.ts, event.type, event.seat ?? null, event.teamId ?? null, JSON.stringify(event.payload));
}

export function nextSeq(matchId: string): number {
  const r = getDb().prepare("SELECT COALESCE(MAX(seq),0) AS m FROM events WHERE match_id=?").get(matchId) as { m: number };
  return r.m + 1;
}

export function eventsAfter(matchId: string, after: number, limit = 20000): Array<{
  seq: number;
  type: EventType;
  seat?: number;
  teamId?: string;
  ts: number;
  payload: Record<string, unknown>;
}> {
  const rows = getDb()
    .prepare("SELECT * FROM events WHERE match_id=? AND seq>? ORDER BY seq LIMIT ?")
    .all(matchId, after, limit) as any[];
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type as EventType,
    seat: r.seat ?? undefined,
    teamId: r.team_id ?? undefined,
    ts: r.ts,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  }));
}

/* ── judgements ────────────────────────────────────────────────────── */

export function saveJudgement(input: {
  matchId: string;
  round: number;
  sudden: boolean;
  judge: ModelSnapshot;
  blindMap: Record<string, string>;
  scores: unknown;
  verdict: string;
  usage: unknown;
}): void {
  getDb()
    .prepare(
      `INSERT INTO judgements (id, match_id, round, sudden, judge_json, blind_map_json, scores_json, verdict, usage_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nid("jud"),
      input.matchId,
      input.round,
      input.sudden ? 1 : 0,
      JSON.stringify(input.judge),
      JSON.stringify(input.blindMap),
      JSON.stringify(input.scores),
      input.verdict,
      JSON.stringify(input.usage),
      Date.now(),
    );
}

export type { MatchState, RoundRecord };
