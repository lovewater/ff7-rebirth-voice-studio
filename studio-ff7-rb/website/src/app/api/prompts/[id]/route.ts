import { getPromptDetail } from "@/lib/prompt-detail";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const data = await getPromptDetail((await params).id);
  return Response.json(data || { error: "提示词不存在" }, { status: data ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}
