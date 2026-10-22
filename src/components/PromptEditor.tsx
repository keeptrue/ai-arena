"use client";

import { useEffect, useRef, useState } from "react";

interface PromptVariable {
  name: string;
  note: string;
  required: boolean;
}

interface PromptSlot {
  key: string;
  label: string;
  group: string;
  description: string;
  variables: PromptVariable[];
  requiredTokens: string[];
  defaultBody: string;
  body: string;
  overridden: boolean;
  updatedAt: number | null;
}

type Notice = { tone: "ok" | "err"; text: string };

export function PromptEditor() {
  const [slots, setSlots] = useState<PromptSlot[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const active = slots.find((s) => s.key === selectedKey) ?? null;
  const dirty = active ? draft !== active.body : false;

  function adopt(list: PromptSlot[], prefer?: string | null) {
    setSlots(list);
    const next = list.find((s) => s.key === prefer) ?? list[0] ?? null;
    setSelectedKey(next?.key ?? null);
    setDraft(next?.body ?? "");
  }

  async function reload(prefer?: string | null) {
    const res = await fetch("/api/prompts", { cache: "no-store" });
    const data = (await res.json()) as { slots?: PromptSlot[]; error?: string };
    if (!res.ok || !data.slots) {
      setNotice({ tone: "err", text: data.error ?? "读取失败" });
      return;
    }
    adopt(data.slots, prefer ?? selectedKey);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(slot: PromptSlot) {
    if (slot.key === selectedKey) return;
    if (dirty && !window.confirm("当前改动还没保存，确定切换吗？")) return;
    setSelectedKey(slot.key);
    setDraft(slot.body);
    setNotice(null);
  }

  function insert(name: string) {
    const token = `{{${name}}}`;
    const area = areaRef.current;
    if (!area) {
      setDraft((d) => d + token);
      return;
    }
    const start = area.selectionStart ?? draft.length;
    const end = area.selectionEnd ?? start;
    const next = draft.slice(0, start) + token + draft.slice(end);
    setDraft(next);
    // Refocus after React commits the new value; rAF is unreliable headless.
    setTimeout(() => {
      area.focus();
      area.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  }

  async function save() {
    if (!active) return;
    setBusy("save");
    setNotice(null);
    try {
      const res = await fetch("/api/prompts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: active.key, body: draft }),
      });
      const data = (await res.json()) as { slots?: PromptSlot[]; error?: string };
      if (!res.ok || !data.slots) throw new Error(data.error ?? "保存失败");
      adopt(data.slots, active.key);
      setNotice({ tone: "ok", text: "已保存，下一轮调用即生效" });
    } catch (err) {
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    if (!active) return;
    if (!window.confirm(`把「${active.label}」恢复成内置版本？已保存的改动会被删除。`)) return;
    setBusy("reset");
    setNotice(null);
    try {
      const res = await fetch(`/api/prompts?key=${encodeURIComponent(active.key)}`, { method: "DELETE" });
      const data = (await res.json()) as { slots?: PromptSlot[]; error?: string };
      if (!res.ok || !data.slots) throw new Error(data.error ?? "恢复失败");
      adopt(data.slots, active.key);
      setNotice({ tone: "ok", text: "已恢复内置版本" });
    } catch (err) {
      setNotice({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const groups: Array<[string, PromptSlot[]]> = [];
  for (const slot of slots) {
    const last = groups[groups.length - 1];
    if (last && last[0] === slot.group) last[1].push(slot);
    else groups.push([slot.group, [slot]]);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <aside className="panel h-fit p-2">
        {groups.map(([group, items]) => (
          <div key={group} className="mb-2 last:mb-0">
            <div className="label px-2 py-1">{group}</div>
            <ul className="space-y-0.5">
              {items.map((slot) => (
                <li key={slot.key}>
                  <button
                    onClick={() => select(slot)}
                    className={`w-full rounded px-2 py-1.5 text-left text-[12px] transition ${
                      selectedKey === slot.key ? "bg-ink-3 text-fg" : "text-fg-dim hover:bg-ink-2"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate">{slot.label}</span>
                      {slot.overridden && (
                        <span
                          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-jade"
                          title="已改过，不用内置版本"
                        />
                      )}
                    </span>
                    <span className="mono block truncate text-[10px] text-fg-faint">{slot.key}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {slots.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-fg-faint">读取中…</p>}
      </aside>

      <section className="flex min-w-0 flex-col gap-3">
        {active ? (
          <>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-[15px] font-medium tracking-tight">{active.label}</h2>
              <span className="mono text-[10px] text-fg-faint">{active.key}</span>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] ${
                  active.overridden ? "border-jade/40 text-jade" : "border-line text-fg-faint"
                }`}
              >
                {active.overridden ? "自定义" : "内置"}
              </span>
              {dirty && <span className="text-[11px] text-amber">未保存</span>}
            </div>
            <p className="max-w-[90ch] text-[12px] leading-relaxed text-fg-faint">{active.description}</p>

            {active.variables.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="label mr-1">可用变量</span>
                {active.variables.map((v) => (
                  <button
                    key={v.name}
                    onClick={() => insert(v.name)}
                    title={v.note}
                    className={`mono rounded border px-1.5 py-0.5 text-[10px] transition hover:bg-ink-3 ${
                      v.required ? "border-jade/40 text-jade" : "border-line text-fg-dim"
                    }`}
                  >
                    {`{{${v.name}}}`}
                    {v.required ? "" : " · 可选"}
                  </button>
                ))}
              </div>
            )}

            {active.requiredTokens.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="label mr-1">协议标记</span>
                {active.requiredTokens.map((token) => (
                  <span
                    key={token}
                    title="保存时会检查，删掉解析器就认不出提交"
                    className="mono rounded border border-amber/40 px-1.5 py-0.5 text-[10px] text-amber"
                  >
                    {token}
                  </span>
                ))}
              </div>
            )}

            <textarea
              ref={areaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              placeholder={active.key === "global.addendum" ? "留空即关闭。写在这里的话会追加到选手与裁判 system 的末尾。" : ""}
              className="mono h-[520px] w-full resize-none rounded-lg border border-line bg-ink-1 p-3 text-[12px] leading-relaxed text-fg outline-none focus:border-jade/40"
            />

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={save}
                disabled={busy !== null || !dirty}
                className="rounded-md border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade transition hover:bg-jade/15 disabled:opacity-40"
              >
                {busy === "save" ? "保存中…" : "保存"}
              </button>
              <button
                onClick={reset}
                disabled={busy !== null || !active.overridden}
                className="rounded-md border border-line px-3 py-1.5 text-[12px] text-fg-dim transition hover:border-line-strong hover:text-fg disabled:opacity-40"
              >
                {busy === "reset" ? "恢复中…" : "恢复默认"}
              </button>
              <span className="mono ml-auto text-[10px] text-fg-faint">{draft.length} 字</span>
            </div>

            {notice && (
              <p
                className={`rounded-md border px-3 py-2 text-[12px] ${
                  notice.tone === "ok"
                    ? "border-jade/30 bg-jade/10 text-jade"
                    : "border-blood/30 bg-blood/10 text-blood"
                }`}
              >
                {notice.text}
              </p>
            )}
          </>
        ) : (
          <p className="panel px-4 py-10 text-center text-[13px] text-fg-faint">没有可编辑的提示词。</p>
        )}
      </section>
    </div>
  );
}
