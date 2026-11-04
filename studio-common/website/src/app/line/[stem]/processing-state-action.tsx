"use client";
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {notifyTtsChanged} from './versions';

export function ProcessingStateAction({stem,skipped,reason}:{stem:string;skipped:boolean;reason:string|null}) {
  const router=useRouter(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function toggle(){
    setBusy(true);setError('');
    try{
      const response=await fetch(`/api/lines/${encodeURIComponent(stem)}/processing-state`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({state:skipped?'active':'skipped',reason:'人工跳过'})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);
      notifyTtsChanged();router.refresh();
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <button type="button" disabled={busy} onClick={()=>void toggle()} className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-300 disabled:opacity-50">{busy?'…':skipped?'取消跳过':'跳过此条'}</button>
    {skipped?<span className="text-zinc-400">跳过 · {reason||'人工跳过'}。不参与自动生成及MOD输出；已有版本与选择保留。</span>:null}
    {error?<span role="alert" className="text-red-400">{error}</span>:null}
  </div>;
}
