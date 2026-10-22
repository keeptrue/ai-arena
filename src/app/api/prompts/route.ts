import {
  clearPromptOverride,
  ensureSeedData,
  listPromptOverrides,
  setPromptOverride,
} from "@/db/repo";
import { isPromptKey, missingTokens, missingVariables, PROMPT_ORDER, PROMPT_SLOTS } from "@/engine/prompt-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Generous, but bounded: a template is prose, not a dataset. */
const MAX_BODY = 20_000;

function serialise() {
  const saved = new Map(listPromptOverrides().map((row) => [row.key, row]));
  return PROMPT_ORDER.map((key) => {
    const slot = PROMPT_SLOTS[key];
    const row = saved.get(key);
    return {
      key,
      label: slot.label,
      group: slot.group,
      description: slot.description,
      variables: slot.variables,
      requiredTokens: slot.requiredTokens,
      defaultBody: slot.defaultBody,
      body: row?.body ?? slot.defaultBody,
      overridden: !!row,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export async function GET() {
  ensureSeedData();
  return Response.json({ slots: serialise() });
}

export async function PUT(req: Request) {
  ensureSeedData();
  const body = (await req.json().catch(() => ({}))) as { key?: string; body?: string };
  if (!body.key || !isPromptKey(body.key)) {
    return Response.json({ error: "未知的提示词" }, { status: 400 });
  }

  const text = (body.body ?? "").trim();
  if (!text) {
    return Response.json({ error: "内容为空；要回到内置版本请用「恢复默认」" }, { status: 400 });
  }
  if (text.length > MAX_BODY) {
    return Response.json({ error: `最多 ${MAX_BODY} 字` }, { status: 400 });
  }

  // A missing placeholder would silently starve the prompt at call time, so the
  // save is rejected while the author still has the editor open.
  const missing = missingVariables(body.key, text);
  if (missing.length) {
    return Response.json(
      { error: `缺少必需占位符：${missing.map((name) => `{{${name}}}`).join("、")}` },
      { status: 400 },
    );
  }

  // The stream parser keys off these markers; losing one means every seat forfeits.
  const tokens = missingTokens(body.key, text);
  if (tokens.length) {
    return Response.json({ error: `缺少协议标记：${tokens.join("、")}` }, { status: 400 });
  }

  setPromptOverride(body.key, text);
  return Response.json({ slots: serialise() });
}

export async function DELETE(req: Request) {
  ensureSeedData();
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!isPromptKey(key)) return Response.json({ error: "未知的提示词" }, { status: 400 });
  clearPromptOverride(key);
  return Response.json({ slots: serialise() });
}
