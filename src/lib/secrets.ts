import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = () => path.join(process.cwd(), "data", "secrets.json");

type SecretMap = Record<string, string>;

function read(): SecretMap {
  try {
    if (!existsSync(FILE())) return {};
    return JSON.parse(readFileSync(FILE(), "utf8")) as SecretMap;
  } catch {
    return {};
  }
}

function write(map: SecretMap): void {
  mkdirSync(path.dirname(FILE()), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(map, null, 2), { mode: 0o600 });
  try {
    chmodSync(FILE(), 0o600);
  } catch {
    /* best effort on non-posix */
  }
}

const ENV_BY_PROVIDER: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GOOGLE_API_KEY",
};

/** UI-entered key wins; env var is the fallback. */
export function getSecret(providerId: string): string {
  const stored = read()[providerId];
  if (stored) return stored;
  const envName = ENV_BY_PROVIDER[providerId];
  return envName ? (process.env[envName] ?? "") : "";
}

export function setSecret(providerId: string, apiKey: string): void {
  const map = read();
  if (apiKey.trim()) map[providerId] = apiKey.trim();
  else delete map[providerId];
  write(map);
}

function mask(key: string): string {
  const trimmed = key.trim();
  // A short key would leak itself through a "last 4 chars" mask.
  return trimmed.length <= 8 ? "••••••••" : `••••${trimmed.slice(-4)}`;
}

/**
 * Never returns the raw key — only enough to recognise it.
 *
 * Every stored key is reported, not just the built-in provider ids: a
 * self-defined provider ("prov_xxx") must light up as configured too.
 */
export function maskedSecrets(): Record<string, string> {
  const map = read();
  const out: Record<string, string> = {};

  for (const [id, key] of Object.entries(map)) {
    if (typeof key === "string" && key.trim()) out[id] = mask(key);
  }

  for (const [id, envName] of Object.entries(ENV_BY_PROVIDER)) {
    if (out[id]) continue;
    const env = process.env[envName];
    if (env) out[id] = `${mask(env)} (env)`;
  }

  return out;
}
