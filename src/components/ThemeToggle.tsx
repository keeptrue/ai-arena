"use client";

import { useEffect, useState } from "react";

type Mode = "light" | "dark" | "auto";
const KEY = "arena-theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(mode: Mode) {
  const resolved = mode === "auto" ? (systemPrefersDark() ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.mode = mode;
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("auto");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = (localStorage.getItem(KEY) as Mode | null) ?? "auto";
      setMode(stored);
    } catch {
      /* file:// and private mode can refuse storage; keep the default */
    }
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      /* the toggle still works in memory */
    }
    applyTheme(mode);

    if (mode !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("auto");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, mounted]);

  const options: Array<{ id: Mode; label: string; glyph: string }> = [
    { id: "light", label: "日间", glyph: "☀" },
    { id: "dark", label: "夜间", glyph: "☾" },
    { id: "auto", label: "自动", glyph: "◐" },
  ];

  return (
    <div
      className="flex items-center gap-0.5 rounded-md border border-line bg-ink-1 p-0.5"
      role="group"
      aria-label="主题"
    >
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => setMode(o.id)}
          aria-pressed={mounted && mode === o.id}
          title={o.label}
          className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] transition ${
            mounted && mode === o.id
              ? "bg-ink-3 text-fg"
              : "text-fg-faint hover:text-fg-dim"
          }`}
        >
          <span aria-hidden className="text-[11px] leading-none">{o.glyph}</span>
          <span className="hidden sm:inline">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
