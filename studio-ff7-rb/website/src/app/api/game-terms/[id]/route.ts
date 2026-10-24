import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { validateGameTerm } from "@/lib/game-term-validation";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
export async function PATCH(req:NextRequest,ctx:Context){
  const id=Number((await ctx.params).id),value=validateGameTerm(await req.json().catch(()=>null));
  if(!Number.isSafeInteger(id)||id<1||!value)return NextResponse.json({error:"无效的词组或记录编号"},{status:400});
  try{
    const rows=await sql`UPDATE game_fixed_terms SET term=${value.term},note=${value.note} WHERE id=${id} RETURNING id`;
    return rows.length?NextResponse.json({ok:true}):NextResponse.json({error:"记录不存在"},{status:404});
  }catch(error){if((error as {code?:string}).code==="23505")return NextResponse.json({error:"这个固定表达已存在"},{status:409});throw error;}
}
export async function DELETE(_req:NextRequest,ctx:Context){
  const id=Number((await ctx.params).id);
  if(!Number.isSafeInteger(id)||id<1)return NextResponse.json({error:"无效的记录编号"},{status:400});
  const rows=await sql`DELETE FROM game_fixed_terms WHERE id=${id} RETURNING id`;
  return rows.length?NextResponse.json({ok:true}):NextResponse.json({error:"记录不存在"},{status:404});
}
