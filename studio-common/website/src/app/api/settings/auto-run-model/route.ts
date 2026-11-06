import { getAutoRunSettings, saveAutoRunSettings } from "@/lib/auto-run-settings";
export const dynamic="force-dynamic";
export async function GET() { return Response.json(await getAutoRunSettings(),{headers:{"Cache-Control":"no-store"}}); }
export async function PUT(request:Request) {
  try { return Response.json(await saveAutoRunSettings(await request.json()),{headers:{"Cache-Control":"no-store"}}); }
  catch(error) {
    const claimed=error instanceof Error&&"status" in error?error.status:null;
    const status=error instanceof SyntaxError?400:claimed===400||claimed===409?claimed:500;
    return Response.json({error:error instanceof SyntaxError?"无效的JSON配置":status!==500?(error as Error).message:"保存接口配置失败"},{status});
  }
}
