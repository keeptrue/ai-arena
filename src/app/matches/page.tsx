import Link from "next/link";
import { MatchBrowser } from "@/components/MatchBrowser";
import { ensureSeedData, listMatches } from "@/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The library shows every match; the header menu reads the same window. */
const LIMIT = 500;

export default async function MatchesPage() {
  ensureSeedData();
  const matches = listMatches(LIMIT);

  return (
    <main className="mx-auto max-w-[1400px] px-6 pb-24">
      <header className="flex flex-wrap items-end justify-between gap-4 py-8">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">所有对局</h1>
          <p className="mt-1.5 max-w-[64ch] text-[13px] leading-relaxed text-fg-dim">
            按规则、种子、胜方或对局 id 找一局——点进去就是完整录像，事件流本身就是回放。
            顶栏的「对局」菜单随时可搜，Ctrl / ⌘ K 也能直接唤出。
          </p>
        </div>
        <Link
          href="/"
          className="rounded-md border border-jade/40 bg-jade/10 px-3 py-1.5 text-[12px] text-jade transition hover:border-jade/60"
        >
          开一局 →
        </Link>
      </header>

      <MatchBrowser matches={matches} now={Date.now()} />
    </main>
  );
}
