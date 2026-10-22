export const SCHEMA_VERSION = 7;

/**
 * Global prompt overrides. One row per edited template; a missing key means the
 * built-in wording in `src/engine/prompt-templates.ts` applies.
 */
export const PROMPT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS prompt_templates (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('openai','anthropic','gemini','mock')),
  base_url    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id                 TEXT PRIMARY KEY,
  provider_id        TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id           TEXT NOT NULL,
  display            TEXT NOT NULL,
  temperature        REAL NOT NULL DEFAULT 0.9,
  supports_reasoning INTEGER NOT NULL DEFAULT 0,
  reasoning_effort   TEXT,
  thinking_budget    INTEGER,
  card_json          TEXT,
  in_contender_pool  INTEGER NOT NULL DEFAULT 1,
  in_judge_pool      INTEGER NOT NULL DEFAULT 1,
  enabled            INTEGER NOT NULL DEFAULT 1,
  context_window     INTEGER,
  fetched_at         INTEGER NOT NULL,
  UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS rulesets (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  source_md       TEXT NOT NULL,
  blueprint_json  TEXT NOT NULL,
  blueprint_hash  TEXT NOT NULL,
  compiled_at     INTEGER,
  compiled_by     TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id                      TEXT PRIMARY KEY,
  ruleset_id              TEXT NOT NULL,
  blueprint_snapshot_json TEXT NOT NULL,
  seed                    TEXT NOT NULL,
  status                  TEXT NOT NULL,
  format                  TEXT NOT NULL,
  budget_json             TEXT NOT NULL,
  judge_json              TEXT,
  calls_used              INTEGER NOT NULL DEFAULT 0,
  tokens_used             INTEGER NOT NULL DEFAULT 0,
  winner_team_id          TEXT,
  end_reason              TEXT,
  created_at              INTEGER NOT NULL,
  finished_at             INTEGER
);

CREATE TABLE IF NOT EXISTS teams (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL,
  total_score  REAL NOT NULL DEFAULT 0,
  forfeits     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(match_id, idx)
);

CREATE TABLE IF NOT EXISTS participants (
  id           TEXT PRIMARY KEY,
  match_id     TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id      TEXT NOT NULL,
  seat         INTEGER NOT NULL,
  model_json   TEXT NOT NULL,
  score_total  REAL NOT NULL DEFAULT 0,
  forfeits     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(match_id, seat)
);

CREATE TABLE IF NOT EXISTS submissions (
  id             TEXT PRIMARY KEY,
  match_id       TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  team_id        TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  status         TEXT NOT NULL,
  thinking       TEXT NOT NULL DEFAULT '',
  content_json   TEXT NOT NULL DEFAULT '{}',
  usage_json     TEXT NOT NULL DEFAULT '{}',
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE(match_id, round, participant_id)
);

CREATE TABLE IF NOT EXISTS events (
  match_id   TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  seat       INTEGER,
  team_id    TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS judgements (
  id             TEXT PRIMARY KEY,
  match_id       TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  sudden         INTEGER NOT NULL DEFAULT 0,
  judge_json     TEXT NOT NULL,
  blind_map_json TEXT NOT NULL,
  scores_json    TEXT NOT NULL,
  verdict        TEXT NOT NULL DEFAULT '',
  usage_json     TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_created ON matches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_match_seq ON events(match_id, seq);
CREATE INDEX IF NOT EXISTS idx_submissions_match ON submissions(match_id, round);

${PROMPT_TABLE_SQL}
`;

/** Tables from the numeric-combat era; dropped on upgrade. */
export const LEGACY_TABLES = ["games"];

export const DEFAULT_PROVIDERS: Array<{
  id: string;
  name: string;
  kind: "openai" | "anthropic" | "gemini" | "mock";
  baseUrl: string;
}> = [
  { id: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1" },
  { id: "openrouter", name: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "moonshot", name: "Moonshot", kind: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "ollama", name: "Ollama (local)", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "gemini", name: "Google Gemini", kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
  { id: "mock", name: "演练场（本地，无需 Key）", kind: "mock", baseUrl: "local://mock" },
];

/** Local rehearsal models so the arena is playable before any key is entered. */
export const MOCK_MODELS: Array<{
  id: string;
  providerId: string;
  modelId: string;
  display: string;
}> = [
  { id: "m-mock-a", providerId: "mock", modelId: "rehearsal-a", display: "演练体 A" },
  { id: "m-mock-b", providerId: "mock", modelId: "rehearsal-b", display: "演练体 B" },
  { id: "m-mock-c", providerId: "mock", modelId: "rehearsal-c", display: "演练体 C" },
  { id: "m-mock-d", providerId: "mock", modelId: "rehearsal-d", display: "演练体 D" },
];

/** Removed in schema v4: models now appear as themselves, with no role-play card. */
export const DROPPED_TABLES = ["personas"];
