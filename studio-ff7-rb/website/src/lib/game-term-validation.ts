import { compactGameTermText } from "./game-term-matching";
export function validateGameTerm(body: unknown) {
  if(!body || typeof body!=="object" || Array.isArray(body))return null;
  const row=body as {term?:unknown;note?:unknown};
  if(typeof row.term!=="string" || (row.note!==undefined && row.note!==null && typeof row.note!=="string"))return null;
  const term=compactGameTermText(row.term),note=typeof row.note==="string"?row.note.trim():"";
  if(!term || term.length>80 || note.length>500)return null;
  return {term,note:note||null};
}
