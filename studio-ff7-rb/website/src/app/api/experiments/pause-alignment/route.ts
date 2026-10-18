import { readPauseExperiment } from "@/lib/pause-experiment";

export const dynamic = "force-dynamic";

export async function GET() {
  const snapshot = await readPauseExperiment();
  return Response.json(snapshot ?? { error: "实验报告尚未生成" }, {
    status: snapshot ? 200 : 404,
    headers: { "Cache-Control": "no-store" },
  });
}
