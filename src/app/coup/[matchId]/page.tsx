import { CoupTable } from "@/components/CoupTable";

export const dynamic = "force-dynamic";

export default async function CoupPage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return <CoupTable matchId={matchId} />;
}
