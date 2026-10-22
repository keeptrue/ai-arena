import { PromptEditor } from "@/components/PromptEditor";
import { ensureSeedData } from "@/db/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  ensureSeedData();

  return (
    <main className="mx-auto max-w-[1400px] px-6 pb-24">
      <header className="py-8">
        <h1 className="text-[22px] font-semibold tracking-tight">提示词</h1>
        <p className="mt-1.5 max-w-[80ch] text-[13px] leading-relaxed text-fg-dim">
          选手、裁判、规则编译器收到的内置提示词都能在这里改。占位符由引擎填动态事实，
          保存时会检查必需项；改完从下一轮模型调用开始生效，历史对局不受影响。
          全局附加指令会追加到选手与裁判的 system 末尾，留空即关闭。
        </p>
      </header>
      <PromptEditor />
    </main>
  );
}
