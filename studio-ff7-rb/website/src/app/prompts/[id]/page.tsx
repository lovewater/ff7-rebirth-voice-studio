import { notFound } from "next/navigation";
import { getPromptDetail } from "@/lib/prompt-detail";
import { PromptDetailView } from "../prompt-detail-view";
export const dynamic = "force-dynamic";
export default async function PromptDetail({ params }: { params: Promise<{ id: string }> }) {
  const data = await getPromptDetail((await params).id);
  if (!data) notFound();
  return <main className="mx-auto max-w-6xl p-3 sm:p-6"><PromptDetailView data={data} /></main>;
}
