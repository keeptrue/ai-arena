import { ArenaView } from "@/components/ArenaView";

export const dynamic = "force-dynamic";

export default async function ArenaPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return <ArenaView matchId={matchId} />;
}
