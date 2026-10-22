import { compileRuleset } from "@/lib/compile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { sourceMd?: string; name?: string };
  const sourceMd = (body.sourceMd ?? "").trim();
  if (sourceMd.length < 20) {
    return Response.json({ error: "规则正文太短，写详细一点再编译" }, { status: 400 });
  }
  try {
    const result = await compileRuleset({ sourceMd, name: body.name });
    return Response.json(result);
  } catch (err) {
    const issues = (err as { issues?: string[] }).issues;
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), issues: issues ?? [] },
      { status: 400 },
    );
  }
}
