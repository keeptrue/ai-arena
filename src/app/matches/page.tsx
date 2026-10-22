import Link from "next/link";
import { ensureSeedData, listMatches, listProviders } from "@/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function MatchesPage() {
  ensureSeedData();
  const matches = listMatches(80);
  void listProviders();

  return (
    <main className="mx-auto max-w-[1400px] px-6 pb-24">
      <header className="py-8">
        <h1 className="text-[22px] font-semibold tracking-tight">战报</h1>
        <p className="mt-1.5 text-[13px] text-fg-dim">点进去逐帧重放——事件流就是录像。</p>
      </header>

      {matches.length === 0 ? (
        <p className="panel px-5 py-10 text-center text-[13px] text-fg-faint">还没有对局记录。</p>
      ) : (
        <div className="panel overflow-hidden">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-[0.16em] text-fg-faint">
                <th className="px-4 py-3 font-normal">规则</th>
                <th className="px-4 py-3 font-normal">阵容</th>
                <th className="px-4 py-3 font-normal">比分</th>
                <th className="px-4 py-3 font-normal">终局</th>
                <th className="px-4 py-3 text-right font-normal">Tokens</th>
                <th className="px-4 py-3 text-right font-normal">时间</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m) => (
                <tr key={m.id} className="border-b border-line/60 transition last:border-0 hover:bg-ink-2/60">
                  <td className="px-4 py-3">
                    <Link href={`/arena/${m.id}`} className="text-fg transition hover:text-jade">
                      {m.rulesetName}
                    </Link>
                    <span className="mono ml-2 text-[10px] text-fg-faint">{m.seed}</span>
                  </td>
                  <td className="mono px-4 py-3 text-fg-dim">{m.format}</td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-2">
                      {m.teams.map((t) => (
                        <span key={t.id} className="mono text-[11px]" style={{ color: t.color }}>
                          {t.name} {t.total.toFixed(2)}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-dim">{m.endReason ?? m.status}</td>
                  <td className="mono px-4 py-3 text-right text-fg-faint">{m.tokensUsed.toLocaleString()}</td>
                  <td className="mono px-4 py-3 text-right text-fg-faint">
                    {new Date(m.createdAt).toLocaleString("zh-CN", { hour12: false })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
