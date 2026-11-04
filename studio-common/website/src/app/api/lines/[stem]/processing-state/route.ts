import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { parseProcessingChange } from "@/lib/line-processing-state";

export const dynamic='force-dynamic';
export async function PATCH(req:NextRequest,ctx:{params:Promise<{stem:string}>}) {
  const {stem}=await ctx.params;
  if(!/^[\w.\-]+$/.test(stem))return NextResponse.json({error:'编号无效'},{status:400});
  let change:ReturnType<typeof parseProcessingChange>;
  try{change=parseProcessingChange(await req.json());}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:String(error)},{status:400});}
  const result=await sql.begin(async tx=>{
    const [line]=await tx<{processing_state:string;skip_reason:string|null}[]>`SELECT processing_state,skip_reason FROM lines WHERE stem=${stem} FOR UPDATE`;
    if(!line)return {status:404,error:'台词不存在'};
    if(line.processing_state===change.state&&line.skip_reason===change.reason)return {status:200,state:change.state,reason:change.reason};
    const running=await tx`SELECT id FROM line_auto_runs WHERE stem=${stem} AND status='running' LIMIT 1`;
    if(running.length)return {status:409,error:'这条正在自动处理，请等本条结束后再修改跳过状态'};
    await tx`UPDATE lines SET processing_state=${change.state},skip_reason=${change.reason},skipped_at=CASE WHEN ${change.state}='skipped' THEN now() ELSE NULL END,updated_at=now() WHERE stem=${stem}`;
    await tx`INSERT INTO line_processing_events(stem,from_state,to_state,reason,source) VALUES(${stem},${line.processing_state},${change.state},${change.reason},'manual')`;
    // Audio, subtitles, review_state and historical run results are untouched.
    return {status:200,state:change.state,reason:change.reason};
  });
  return NextResponse.json(result.status===200?{ok:true,...result}:{error:result.error},{status:result.status});
}
