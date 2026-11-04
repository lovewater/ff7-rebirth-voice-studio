import { compactGameTermText } from "./game-term-matching";
export function validateGameTerm(body: unknown) {
  if(!body || typeof body!=="object" || Array.isArray(body))return null;
  const row=body as {term?:unknown;note?:unknown};
  if(typeof row.term!=="string" || (row.note!==undefined && row.note!==null && typeof row.note!=="string"))return null;
  // 匹配时的归一不能用于存储：型号空格、罗马数字和版本小数点均属于用户原文。
  const term=row.term.trim(),note=typeof row.note==="string"?row.note.trim():"";
  if(!compactGameTermText(term) || term.length>80 || note.length>500)return null;
  return {term,note:note||null};
}
