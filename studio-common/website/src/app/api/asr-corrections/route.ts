import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { validateAsrWordRule, correctAsrWords, type AsrWordRule } from "@/lib/asr-word-corrections";

export const dynamic="force-dynamic";
export async function GET() {
  const rows=await sql<AsrWordRule[]>`SELECT id,word,aliases,enabled,note FROM asr_word_corrections ORDER BY word`;
  return NextResponse.json({rows});
}
export async function POST(req:NextRequest) {
  let value:ReturnType<typeof validateAsrWordRule>;
  try { value=validateAsrWordRule(await req.json()); }
  catch(error) { return NextResponse.json({error:error instanceof Error?error.message:String(error)},{status:400}); }
  try {
    const [row]=await sql`INSERT INTO asr_word_corrections(word,aliases,enabled,note) VALUES(${value.word},${value.aliases},${value.enabled},${value.note}) RETURNING id`;
    return NextResponse.json({ok:true,id:row.id});
  } catch(error) {
    const e=error as {code?:string};
    if(e.code==='23505')return NextResponse.json({error:'这个标准词已存在，请编辑原有词组'},{status:409});
    throw error;
  }
}

/** CPU-only preview. Never starts ASR/TTS/LLM or edits the original transcript. */
export async function PUT(req:NextRequest) {
  const body=await req.json().catch(()=>null) as {script?:unknown;asr?:unknown}|null;
  if(!body||typeof body.script!=='string'||typeof body.asr!=='string'||body.script.length>2000||body.asr.length>4000)
    return NextResponse.json({error:'请填写朗读稿和ASR文字（分别最多2000/4000字）'},{status:400});
  const rows=await sql<AsrWordRule[]>`SELECT id,word,aliases,enabled,note FROM asr_word_corrections WHERE enabled=true ORDER BY id`;
  return NextResponse.json(correctAsrWords(body.script,body.asr,rows));
}
