#!/usr/bin/env node
// Read-only decoder using the tool author's MIT-licensed FF7R Data Editor.
const fs=require('fs'),path=require('path');
const project=path.resolve(__dirname,'..'),tool=path.join(project,'work/tools/ff7r-data-editor');
const {UPackage}=require('./remake_dataobject.cjs');
async function main(){const assets=JSON.parse(fs.readFileSync(path.join(project,'work/text-assets.json'))).filter(x=>x.kind==='metadata'&&x.path.endsWith('.uasset'));let failed=[];
for(const asset of assets){try{const p=new UPackage(path.join(project,'work/metadata-raw',asset.path));await p.read();const out=path.join(project,'work/metadata-json',asset.path.replace(/\.uasset$/,'.json'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify({source:asset,...p.toJSON()},null,2));}catch(e){failed.push({path:asset.path,error:e.message})}}
fs.writeFileSync(path.join(project,'work/metadata-errors.json'),JSON.stringify(failed,null,2));console.log(JSON.stringify({parsed:assets.length-failed.length,failed:failed.length}));}
main().catch(e=>{console.error(e);process.exitCode=1});
