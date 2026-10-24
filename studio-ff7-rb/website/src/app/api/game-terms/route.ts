import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { validateGameTerm } from "@/lib/game-term-validation";
export const dynamic="force-dynamic";
export async function GET(){
  const rows=await sql`SELECT id,term,note FROM game_fixed_terms ORDER BY char_length(term) DESC,term`;
  return NextResponse.json({rows});
}
export async function POST(req:NextRequest){
  const value=validateGameTerm(await req.json().catch(()=>null));
  if(!value)return NextResponse.json({error:"词组不能为空且最长80字，备注最长500字"},{status:400});
  try{
    const [row]=await sql`INSERT INTO game_fixed_terms(term,note) VALUES(${value.term},${value.note}) RETURNING id`;
    return NextResponse.json({ok:true,id:row.id});
  }catch(error){if((error as {code?:string}).code==="23505")return NextResponse.json({error:"这个固定表达已存在"},{status:409});throw error;}
}
