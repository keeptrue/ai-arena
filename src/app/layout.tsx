import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "斗场 · AI Arena",
  description: "规则由你写，阵容由你挑。全员并行出招，裁判统一裁决。",
};

const THEME_BOOT = `(function(){try{var m=localStorage.getItem('arena-theme')||'auto';var d=m==='auto'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):m;var e=document.documentElement;e.dataset.theme=d;e.dataset.mode=m;}catch(_){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="dark" data-mode="auto" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-screen antialiased">
        <header className="sticky top-0 z-40 border-b border-line bg-ink-0/85 backdrop-blur-md">
          <div className="mx-auto flex min-h-14 max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:flex-nowrap sm:gap-6 sm:px-6 sm:py-0">
            <Link href="/" className="group flex items-center gap-2.5">
              <span className="relative flex h-6 w-6 items-center justify-center">
                <span className="absolute inset-0 rounded-full bg-jade/15 ring-1 ring-jade/40" />
                <span className="relative text-[11px]">⚔</span>
              </span>
              <span className="text-[15px] font-semibold tracking-tight">斗场</span>
              <span className="label mt-0.5 hidden sm:inline">ARENA</span>
            </Link>
            <nav className="ml-auto flex items-center gap-1 text-[13px]">
              <NavLink href="/">开局</NavLink>
              <NavLink href="/rulesets">规则</NavLink>
              <NavLink href="/matches">战报</NavLink>
              <NavLink href="/prompts">提示词</NavLink>
              <NavLink href="/setups">配置</NavLink>
            </nav>
            <ThemeToggle />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-2 py-1.5 text-fg-dim transition hover:bg-ink-2 hover:text-fg sm:px-3"
    >
      {children}
    </Link>
  );
}
