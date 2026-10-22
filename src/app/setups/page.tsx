import { SetupEditor } from "@/components/SetupEditor";
import { ensureRuntime } from "@/engine/runtime";
import { ensureSeedData } from "@/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SetupsPage() {
  ensureRuntime();
  ensureSeedData();

  return (
    <main className="mx-auto max-w-[1200px] px-6 pb-24">
      <header className="py-8">
        <h1 className="text-[22px] font-semibold tracking-tight">配置</h1>
        <p className="mt-1.5 max-w-[60ch] text-[13px] leading-relaxed text-fg-dim">
          接入模型、挑选手与裁判。选手与裁判会尽量错开厂商——同一家模型既上场又打分，
          是这套系统最早会崩的地方。模型以自己的身份说话，不套角色设定。
        </p>
      </header>
      <SetupEditor />
    </main>
  );
}
