"use client";

import { useEffect, useState } from "react";

type Row={id:number;word:string;aliases:string[];enabled:boolean;note:string|null;aliasesText:string};
type Preview={rawText:string;correctedText:string;reason:string;hits:{word:string;alias:string}[]};
const aliases=(s:string)=>[...new Set(s.split(/[\s,，、;；]+/u).map(x=>x.trim()).filter(Boolean))];
const inputClass="rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100";
export default function AsrCorrectionsPanel() {
  const [rows,setRows]=useState<Row[]>([]),[word,setWord]=useState(''),[aliasText,setAliasText]=useState(''),[note,setNote]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [script,setScript]=useState('威吉发现危机'),[asr,setAsr]=useState('危机发现危机'),[preview,setPreview]=useState<Preview|null>(null);
  async function request(url:string,init?:RequestInit) {
    const response=await fetch(url,{cache:'no-store',...init});const value=await response.json();
    if(!response.ok)throw new Error(value.error||`HTTP ${response.status}`);return value;
  }
  async function load() {
    const value=await request('/api/asr-corrections');setRows(value.rows.map((r:Row)=>({...r,aliasesText:r.aliases.join('、')})));
  }
  useEffect(()=>{
    let active=true;
    void fetch('/api/asr-corrections',{cache:'no-store'}).then(async response=>{
      const value=await response.json();if(!response.ok)throw new Error(value.error||`HTTP ${response.status}`);return value.rows as Row[];
    }).then(value=>{if(active)setRows(value.map(r=>({...r,aliasesText:r.aliases.join('、')})));})
      .catch(e=>{if(active)setError(String(e));});
    return()=>{active=false;};
  },[]);
  async function mutate(action:()=>Promise<void>) {
    setBusy(true);setError('');setPreview(null);
    try{await action();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function add() {
    await mutate(async()=>{
      await request('/api/asr-corrections',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({word,aliases:aliases(aliasText),note,enabled:true})});
      setWord('');setAliasText('');setNote('');await load();
    });
  }
  async function save(row:Row) {
    await mutate(async()=>{
      await request(`/api/asr-corrections/${row.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({word:row.word,aliases:aliases(row.aliasesText),enabled:row.enabled,note:row.note})});await load();
    });
  }
  async function remove(row:Row) {
    if(!window.confirm(`删除“${row.word}”的ASR纠错词组？`))return;
    await mutate(async()=>{await request(`/api/asr-corrections/${row.id}`,{method:'DELETE'});await load();});
  }
  function edit(id:number,patch:Partial<Row>){setRows(current=>current.map(r=>r.id===id?{...r,...patch}:r));setPreview(null);}
  return <div>
    <p className="mt-4 text-sm leading-6 text-zinc-400">朗读稿中有标准词时，将对应位置的识别别名按标准词核字。初审和终审共用规则；原始ASR与时间轴保留，TTS和字幕使用原稿。</p>
    <form className="mt-5 grid gap-3 rounded border border-zinc-800 p-4 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void add();}}>
      <label className="text-xs text-zinc-400">标准词<input aria-label="新增标准词" value={word} onChange={e=>setWord(e.target.value)} maxLength={40} required className={`${inputClass} mt-1 block w-full`}/></label>
      <label className="text-xs text-zinc-400">备注<input aria-label="新增备注" value={note} onChange={e=>setNote(e.target.value)} maxLength={500} className={`${inputClass} mt-1 block w-full`}/></label>
      <label className="text-xs text-zinc-400 sm:col-span-2">识别别名（逗号、顿号或换行分隔）<textarea aria-label="新增识别别名" value={aliasText} onChange={e=>setAliasText(e.target.value)} rows={2} required placeholder="例如：危机、危急、微机、维基" className={`${inputClass} mt-1 block w-full`}/></label>
      <div><button disabled={busy} className="rounded bg-sky-900 px-3 py-1.5 text-sm text-sky-100 disabled:opacity-50">新增词组</button></div>
    </form>
    {error?<p role="alert" className="mt-3 text-sm text-red-400">{error}</p>:null}
    <div className="mt-5 space-y-3">{rows.map(row=><article key={row.id} className="rounded border border-zinc-800 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-zinc-400">标准词<input aria-label={`标准词 ${row.id}`} value={row.word} onChange={e=>edit(row.id,{word:e.target.value})} maxLength={40} className={`${inputClass} ml-2 w-32`}/></label>
        <label className="flex items-center gap-1.5 text-sm text-zinc-400"><input type="checkbox" checked={row.enabled} onChange={e=>edit(row.id,{enabled:e.target.checked})} aria-label={`启用 ${row.word}`}/>启用</label>
        <div className="ml-auto flex gap-4 text-sm"><button type="button" disabled={busy} onClick={()=>void save(row)} className="text-sky-300 disabled:opacity-50">保存</button><button type="button" disabled={busy} onClick={()=>void remove(row)} className="text-red-400 disabled:opacity-50">删除</button></div>
      </div>
      <label className="mt-3 block text-xs text-zinc-400">识别别名<textarea aria-label={`${row.word}的识别别名`} rows={2} value={row.aliasesText} onChange={e=>edit(row.id,{aliasesText:e.target.value})} className={`${inputClass} mt-1 block w-full`}/></label>
      <label className="mt-2 block text-xs text-zinc-400">备注<input aria-label={`${row.word}的备注`} value={row.note??''} onChange={e=>edit(row.id,{note:e.target.value})} maxLength={500} className={`${inputClass} mt-1 block w-full text-zinc-400`}/></label>
    </article>)}</div>
    <form className="mt-6 rounded border border-zinc-800 p-4" onSubmit={e=>{e.preventDefault();void mutate(async()=>setPreview(await request('/api/asr-corrections',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({script,asr})})));}}>
      <h2 className="text-sm text-zinc-200">测试已保存的规则</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-zinc-400">朗读稿<textarea aria-label="测试朗读稿" value={script} onChange={e=>{setScript(e.target.value);setPreview(null);}} rows={2} maxLength={2000} className={`${inputClass} mt-1 block w-full`}/></label>
        <label className="text-xs text-zinc-400">原始ASR<textarea aria-label="测试原始ASR" value={asr} onChange={e=>{setAsr(e.target.value);setPreview(null);}} rows={2} maxLength={4000} className={`${inputClass} mt-1 block w-full`}/></label>
      </div>
      <button disabled={busy} className="mt-3 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 disabled:opacity-50">测试纠错</button>
      {preview?<div role="status" className="mt-3 space-y-1 text-sm text-zinc-300"><p>核字使用：{preview.correctedText||'（空）'}</p><p className="text-xs text-zinc-500">{preview.hits.length?preview.hits.map(h=>`${h.alias} → ${h.word}`).join('；'):preview.reason==='ambiguous'?'对应位置不唯一，保留原识别':'未命中，保留原识别'} · 仅测试文字，不生成音频</p></div>:null}
    </form>
  </div>;
}
