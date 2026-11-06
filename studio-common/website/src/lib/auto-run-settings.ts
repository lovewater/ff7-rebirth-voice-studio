import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "./db";
export type AutoRunConnectionId = "grok" | "primary";
export type AutoRunConnection = { base: string; model: string; key: string };
type Stored = { model: AutoRunConnectionId; connections: Partial<Record<AutoRunConnectionId, AutoRunConnection>>; updated_at: Date | string };
const ids: AutoRunConnectionId[] = ["grok", "primary"];
export function validAutoRunModel(value: unknown): value is AutoRunConnectionId { return value === "grok" || value === "primary"; }
function environment(id: AutoRunConnectionId): AutoRunConnection {
  return id === "grok" ? {base:process.env.GROK_LLM_URL?.trim() || "",model:process.env.GROK_LLM_MODEL?.trim() || "grok-4.7",key:process.env.GROK_LLM_KEY?.trim() || ""}
    : {base:process.env.REWRITE_LLM_URL?.trim() || "",model:process.env.REWRITE_LLM_MODEL?.trim() || "glm-5.3",key:process.env.REWRITE_LLM_KEY?.trim() || ""};
}
async function stored(): Promise<Stored | undefined> {
  const [row] = await sql<Stored[]>`SELECT model,connections,updated_at FROM auto_run_settings WHERE id=1`;
  return row;
}
function resolve(id: AutoRunConnectionId, row?: Stored): AutoRunConnection { return {...environment(id),...row?.connections[id]}; }
export async function getAutoRunModel(): Promise<AutoRunConnectionId> { return (await stored())?.model ?? "grok"; }
const connectionContext = new AsyncLocalStorage<{id:AutoRunConnectionId;connection:AutoRunConnection}>();
export async function getAutoRunConnection(id: AutoRunConnectionId): Promise<AutoRunConnection> {
  const active=connectionContext.getStore();
  return active?.id===id?active.connection:resolve(id,await stored());
}
export async function withAutoRunConnection<T>(id:AutoRunConnectionId, operation:()=>T):Promise<Awaited<T>> {
  const connection=Object.freeze(resolve(id,await stored()));
  return await connectionContext.run({id,connection},operation);
}
function publicSettings(row?: Stored) {
  return { model: row?.model ?? "grok", updatedAt:row?.updated_at ?? null, connections:ids.map(id=>{
    const connection=resolve(id,row);
    return {id,name:id==="primary"?"官方GLM 5.3":"Grok",base:connection.base,model:connection.model,hasKey:!!connection.key,configured:!!(connection.base&&connection.model&&connection.key)};
  })};
}
export async function getAutoRunSettings() { return publicSettings(await stored()); }
function invalid(message:string):never { throw Object.assign(new Error(message),{status:400}); }
export function parseAutoRunSettings(value:unknown) {
  if(!value||typeof value!=="object"||Array.isArray(value))invalid("无效的接口配置");
  const body=value as Record<string,unknown>;
  if(!validAutoRunModel(body.model))invalid("请选择受支持的自动流程接口");
  if(body.connections!==undefined&&!Array.isArray(body.connections))invalid("接口配置须为数组");
  const connections: {id:AutoRunConnectionId;base:string;model:string;key?:string}[]=[];
  for(const raw of (body.connections ?? []) as unknown[]) {
    if(!raw||typeof raw!=="object"||Array.isArray(raw))invalid("无效的接口配置");
    const item=raw as Record<string,unknown>;
    if(!validAutoRunModel(item.id)||connections.some(x=>x.id===item.id))invalid("接口重复或不受支持");
    if(typeof item.base!=="string"||item.base.length>2000)invalid("接口地址无效");
    let url:URL;try{url=new URL(item.base.trim());}catch{invalid("接口地址须为HTTP或HTTPS地址");}
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)invalid("接口地址不得含凭据、查询参数或锚点");
    if(typeof item.model!=="string"||!/^[a-zA-Z0-9_.:-]{1,128}$/.test(item.model.trim()))invalid("模型名称无效");
    if(item.key!==undefined&&(typeof item.key!=="string"||item.key.length>4096||/[\r\n]/.test(item.key)))invalid("密钥格式无效");
    connections.push({id:item.id,base:item.base.trim().replace(/\/+$/,""),model:item.model.trim(),...(typeof item.key==="string"&&item.key.trim()?{key:item.key.trim()}:{})});
  }
  return {model:body.model,connections};
}
export async function saveAutoRunSettings(value: unknown) {
  const input=parseAutoRunSettings(value);
  return sql.begin(async tx=>{
    // Serialize read-modify-write and retain an omitted/blank key safely.
    await tx`SELECT pg_advisory_xact_lock(70261105)`;
    const [before]=await tx<Stored[]>`SELECT model,connections,updated_at FROM auto_run_settings WHERE id=1 FOR UPDATE`;
    const connections={...before?.connections};
    for(const item of input.connections)connections[item.id]={...resolve(item.id,before),...item};
    const credentialsChanged=input.connections.some(item=>{
      const previous=resolve(item.id,before),next=connections[item.id]!;
      return previous.base!==next.base||previous.model!==next.model||previous.key!==next.key;
    });
    if(credentialsChanged) {
      const running=await tx`SELECT id FROM line_auto_runs WHERE status='running' LIMIT 1`;
      if(running.length)throw Object.assign(new Error("有自动任务运行中，请完成后再修改接口地址、模型或密钥；可切换新任务默认接口"),{status:409});
    }
    const next:Stored={model:input.model,connections,updated_at:new Date()};
    const selected=resolve(input.model,next);
    if(!selected.base||!selected.model||!selected.key)invalid("所选接口尚未配置地址、模型和密钥");
    await tx`INSERT INTO auto_run_settings(id,model,connections,updated_at) VALUES(1,${input.model},${tx.json(connections)},now())
      ON CONFLICT(id) DO UPDATE SET model=EXCLUDED.model,connections=EXCLUDED.connections,updated_at=now()`;
    // Never audit credentials or full connection objects.
    await tx`INSERT INTO auto_run_settings_events(previous_model,model,changes) VALUES(${before?.model??"grok"},${input.model},${tx.json(input.connections.map(item=>({id:item.id,base:item.base,model:item.model,keyChanged:!!item.key})))})`;
    return publicSettings(next);
  });
}
