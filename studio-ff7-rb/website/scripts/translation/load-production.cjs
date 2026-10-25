// 独立后台脚本直接复用正式通用模型入口/日志/模板；只转译TypeScript，不改写任何业务源码。
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const base=path.resolve(__dirname,'../..'),req=Module.createRequire(base+'/package.json'),ts=req('typescript');
req('@next/env').loadEnvConfig(base,false,{info(){},error(){}});
const parentEnv=path.dirname(base)+'/.env';
for(const line of (fs.existsSync(parentEnv)?fs.readFileSync(parentEnv,'utf8'):'').split(/\r?\n/)){
 const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
 if(m&&/^(SELF_HOSTED_|VOLCENGINE_LLM_|TRANSLATION_)/.test(m[1]))process.env[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');
}
// 可读取翻译专用运行配置；真实地址/密钥仅存ignored env，绝不硬编码。
const config=process.env.TRANSLATION_ENV_FILE;
if(config)for(const line of fs.readFileSync(config,'utf8').split(/\r?\n/)){
 const m=line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
 if(m&&/^(SELF_HOSTED_|TRANSLATION_)/.test(m[1]))process.env[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');
}
const cache=new Map();
function load(file){
 if(cache.has(file))return cache.get(file).exports;
 const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));cache.set(file,m);
 m.require=id=>id.startsWith('@/')?resolve(base+'/src/'+id.slice(2)):id.startsWith('.')?resolve(path.resolve(path.dirname(file),id)):req(id);
 m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
 return m.exports;
}
function resolve(file){for(const f of [file,file+'.ts',file+'.js',file+'/index.ts'])if(fs.existsSync(f)&&fs.statSync(f).isFile())return f.endsWith('.ts')?load(f):req(f);throw Error('模块不存在');}
module.exports={base,load};
