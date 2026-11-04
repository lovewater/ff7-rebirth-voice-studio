import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { validateAsrWordRule } from "@/lib/asr-word-corrections";

export const dynamic="force-dynamic";
export async function PATCH(req:NextRequest,ctx:{params:Promise<{id:string}>}) {
  const id=Number((await ctx.params).id);
  if(!Number.isSafeInteger(id)||id<=0)return NextResponse.json({error:'编号无效'},{status:400});
  let value:ReturnType<typeof validateAsrWordRule>;
  try { value=validateAsrWordRule(await req.json()); }
  catch(error) { return NextResponse.json({error:error instanceof Error?error.message:String(error)},{status:400}); }
  try {
    const rows=await sql`UPDATE asr_word_corrections SET word=${value.word},aliases=${value.aliases},enabled=${value.enabled},note=${value.note},updated_at=now() WHERE id=${id} RETURNING id`;
    return rows.length?NextResponse.json({ok:true}):NextResponse.json({error:'词组不存在'},{status:404});
  } catch(error) {
    if((error as {code?:string}).code==='23505')return NextResponse.json({error:'这个标准词已存在'},{status:409});
    throw error;
  }
}
export async function DELETE(_req:NextRequest,ctx:{params:Promise<{id:string}>}) {
  const id=Number((await ctx.params).id);
  if(!Number.isSafeInteger(id)||id<=0)return NextResponse.json({error:'编号无效'},{status:400});
  const rows=await sql`DELETE FROM asr_word_corrections WHERE id=${id} RETURNING id`;
  return rows.length?NextResponse.json({ok:true}):NextResponse.json({error:'词组不存在'},{status:404});
}
