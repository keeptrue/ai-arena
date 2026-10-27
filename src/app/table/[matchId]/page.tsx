import { WerewolfTable } from "@/components/WerewolfTable";

export const dynamic = "force-dynamic";

export default async function TablePage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return <WerewolfTable matchId={matchId} />;
}
