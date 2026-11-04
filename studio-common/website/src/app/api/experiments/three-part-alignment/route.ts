import {readThreePartExperiment} from "@/lib/pause-experiment";
export const dynamic="force-dynamic";
export async function GET(){const snapshot=await readThreePartExperiment();return Response.json(snapshot??{error:"实验报告尚未生成"},{status:snapshot?200:404,headers:{"Cache-Control":"no-store"}});}
