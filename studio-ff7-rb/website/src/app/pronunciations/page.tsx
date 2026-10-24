import { Suspense } from "react";
import PronunciationsClient from "./pronunciations-client";

export default function PronunciationsPage(){
  return <Suspense fallback={<main className="mx-auto max-w-4xl p-6 text-zinc-400">正在加载词库…</main>}><PronunciationsClient/></Suspense>;
}
