// Read-only legacy DataObject adapter. UE FName stores a name index AND an instance number.
const path=require('node:path');
const tool=path.resolve(__dirname,'../work/tools/ff7r-data-editor/lib');
const UPackage=require(path.join(tool,'upackage'));
const UExport=require(path.join(tool,'uexport'));
function readCompleteFName(){
 const index=this.readInt32(),number=this.readInt32();
 const base=this.uasset.names[index];
 if(typeof base!=='string'||number<0)throw Error('invalid-legacy-fname');
 return number===0?base:`${base}_${number-1}`;
}
// Upstream discards the second int32, which silently merges rows such as _100/_110/_120.
// This matches programs/vendor/retoc/retoc/src/name_map.rs FString formatting.
UExport.prototype.readFName=readCompleteFName;
module.exports={UPackage,readCompleteFName};
