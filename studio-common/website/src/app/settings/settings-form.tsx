"use client";
import { useState } from "react";
type Settings={model:"grok"|"primary";updatedAt:Date|string|null;connections:{id:"grok"|"primary";name:string;base:string;model:string;hasKey:boolean;configured:boolean}[]};
export function AutoRunSettingsForm({initial}:{initial:Settings}) {
  const [data,setData]=useState(initial),[keys,setKeys]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const change=(id:string,field:"base"|"model",value:string)=>setData(previous=>({...previous,connections:previous.connections.map(c=>c.id===id?{...c,[field]:value}:c)}));
  async function save(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setMessage("");
    try {
      const response=await fetch("/api/settings/auto-run-model",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:data.model,connections:data.connections.filter(c=>c.base.trim()||c.id===data.model).map(c=>({id:c.id,base:c.base,model:c.model,key:keys[c.id]||""}))})});
      const result=await response.json();if(!response.ok)throw Error(result.error||"保存失败");setData(result);setKeys({});setMessage("已保存，新任务将使用所选接口。");
    }catch(error){setMessage(error instanceof Error?error.message:"保存失败");}finally{setBusy(false);}
  }
  return <form onSubmit={save} className="space-y-5"><fieldset disabled={busy} className="space-y-5"><label className="block space-y-2 text-sm"><span>自动流程接口</span><select value={data.model} onChange={event=>setData({...data,model:event.target.value as Settings["model"]})} className="w-full rounded border border-zinc-700 bg-zinc-900 p-2.5">{data.connections.map(c=><option key={c.id} value={c.id}>{c.name}{c.configured?"":"（待配置）"}</option>)}</select></label>
    {data.connections.map(c=><section key={c.id} className="space-y-4 rounded-lg border border-zinc-800 p-4"><h2 className="font-medium">{c.name}<span className="ml-2 text-xs text-zinc-500">{c.configured?"已配置":"待配置"}</span></h2><label className="block space-y-1 text-sm"><span>接口地址</span><input required={c.id===data.model} type="url" value={c.base} onChange={e=>change(c.id,"base",e.target.value)} className="w-full rounded border border-zinc-700 bg-zinc-900 p-2"/></label><label className="block space-y-1 text-sm"><span>模型</span><input required={c.id===data.model} value={c.model} onChange={e=>change(c.id,"model",e.target.value)} className="w-full rounded border border-zinc-700 bg-zinc-900 p-2"/></label><label className="block space-y-1 text-sm"><span>API 密钥</span><input type="password" autoComplete="new-password" value={keys[c.id]||""} placeholder={c.hasKey?"已配置，留空保留现有密钥":"输入 API 密钥"} onChange={e=>setKeys({...keys,[c.id]:e.target.value})} className="w-full rounded border border-zinc-700 bg-zinc-900 p-2"/></label></section>)}
    <button type="submit" className="rounded bg-sky-700 px-4 py-2 text-sm text-white disabled:opacity-50">{busy?"保存中…":"保存配置"}</button></fieldset><p role="status" aria-live="polite" className="text-sm text-zinc-300">{message}</p></form>;
}
