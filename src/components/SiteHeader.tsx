import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The site chrome, shared by the live layout and the offline export.
 *
 * Brand / pin / nav are slots: the live app passes Next links and the match pin,
 * while the exported file passes inert spans (there is no router or server to
 * navigate to). Everything below is class-for-class identical.
 */

export const HEADER_NAV_ITEMS = [
  { href: "/", label: "开局" },
  { href: "/rulesets", label: "规则" },
  // The live layout swaps this one for the searchable MatchMenu dropdown; the
  // frozen export still renders it as a plain label.
  { href: "/matches", label: "对局" },
  { href: "/prompts", label: "提示词" },
  { href: "/setups", label: "配置" },
] as const;

export const HEADER_NAV_CLASS =
  "rounded-md px-2 py-1.5 text-fg-dim transition hover:bg-ink-2 hover:text-fg sm:px-3";

export function BrandMark() {
  return (
    <>
      <span className="relative flex h-6 w-6 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-jade/15 ring-1 ring-jade/40" />
        <span className="relative text-[11px]">⚔</span>
      </span>
      <span className="text-[15px] font-semibold tracking-tight">斗场</span>
      <span className="label mt-0.5 hidden sm:inline">ARENA</span>
    </>
  );
}

/** Nav for a frozen page: same pixels, no destination. */
export function StaticHeaderNav() {
  return (
    <>
      {HEADER_NAV_ITEMS.map((item) => (
        <span key={item.href} className={`${HEADER_NAV_CLASS} cursor-default`}>
          {item.label}
        </span>
      ))}
    </>
  );
}

export function SiteHeader({
  brand,
  pin,
  nav,
}: {
  brand: ReactNode;
  /** The live "back to the match" chip; the export passes nothing. */
  pin?: ReactNode;
  nav: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink-0/85 backdrop-blur-md">
      <div className="mx-auto flex min-h-14 max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:gap-6 sm:px-6 sm:py-0">
        {brand}
        {/* Kept before the nav so it reads as "where I was", not as another link. */}
        {pin}
        <nav className="ml-auto flex items-center gap-1 text-[13px]">{nav}</nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
