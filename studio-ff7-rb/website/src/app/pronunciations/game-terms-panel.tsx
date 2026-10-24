"use client";
import { useEffect, useState } from "react";
type Row={id:number;term:string;note:string|null};
const inputClass="mt-1 block w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100";
export default function GameTermsPanel(){
  const [rows,setRows]=useState<Row[]>([]),[term,setTerm]=useState(""),[note,setNote]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function request(url:string,init?:RequestInit){const response=await fetch(url,{cache:"no-store",...init});const data=await response.json();if(!response.ok)throw Error(data.error??`HTTP ${response.status}`);return data;}
  async function load(){const data=await request("/api/game-terms");setRows(data.rows);}
  useEffect(()=>{let active=true;void fetch("/api/game-terms",{cache:"no-store"}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error??`HTTP ${r.status}`);return d.rows as Row[];}).then(data=>{if(active)setRows(data);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[]);
  async function mutate(url:string,method:string,value?:unknown){setBusy(true);setError("");try{await request(url,{method,headers:{"content-type":"application/json"},...(value===undefined?{}:{body:JSON.stringify(value)})});await load();if(method==="POST"){setTerm("");setNote("");}}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  return <>
    <p className="mt-4 text-sm leading-6 text-zinc-400">中文原稿或当前稿去掉标点、符号及空白后仍包含词组，就提醒大模型保留该游戏固定表达。改稿、时长调整和润色都适用。</p>
    <form className="mt-5 flex flex-wrap items-end gap-3" onSubmit={e=>{e.preventDefault();void mutate("/api/game-terms","POST",{term,note});}}>
      <label className="text-xs text-zinc-400">固定表达<input className={inputClass} value={term} onChange={e=>setTerm(e.target.value)} maxLength={80} required /></label>
      <label className="min-w-56 flex-1 text-xs text-zinc-400">备注<input className={inputClass} value={note} onChange={e=>setNote(e.target.value)} maxLength={500}/></label>
      <button disabled={busy} className="rounded bg-sky-900 px-3 py-2 text-sm text-sky-100 disabled:opacity-50">新增</button>
    </form>
    {error?<p role="alert" className="mt-3 text-sm text-red-400">{error}</p>:null}
    <table className="mt-5 w-full text-left text-sm"><thead className="text-zinc-500"><tr><th className="py-2">固定表达</th><th>备注</th><th className="sr-only">操作</th></tr></thead><tbody>
      {rows.map(row=><tr key={row.id} className="border-t border-zinc-800">
        <td className="py-2 pr-3"><input aria-label={`固定表达 ${row.id}`} className={inputClass} value={row.term} maxLength={80} onChange={e=>setRows(old=>old.map(r=>r.id===row.id?{...r,term:e.target.value}:r))}/></td>
        <td className="pr-3"><input aria-label={`备注 ${row.id}`} className={inputClass} value={row.note??""} maxLength={500} onChange={e=>setRows(old=>old.map(r=>r.id===row.id?{...r,note:e.target.value}:r))}/></td>
        <td className="whitespace-nowrap text-right"><button disabled={busy} className="text-sky-300 hover:underline disabled:opacity-50" onClick={()=>void mutate(`/api/game-terms/${row.id}`,"PATCH",row)}>保存</button><button disabled={busy} className="ml-3 text-red-400 hover:underline disabled:opacity-50" onClick={()=>{if(window.confirm(`删除固定表达“${row.term}”？`))void mutate(`/api/game-terms/${row.id}`,"DELETE");}}>删除</button></td>
      </tr>)}
    </tbody></table>
    {!rows.length&&!error?<p className="mt-3 text-sm text-zinc-500">暂无固定表达。</p>:null}
  </>;
}
