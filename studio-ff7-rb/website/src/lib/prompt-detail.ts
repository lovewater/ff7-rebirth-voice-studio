import { sql } from "@/lib/db";
import type { PromptRow } from "@/lib/prompt-store";

/** 弹窗和独立详情共用只读查询；列表不预载完整提示词。 */
export async function getPromptDetail(id: string) {
  if (!/^[1-9]\d*$/.test(id) || BigInt(id)>BigInt("9223372036854775807")) return null;
  const [row] = await sql<(PromptRow & { current: boolean })[]>`
    SELECT p.id::text AS id,p.key,p.category,p.name,p."desc",p.prompt,p.enable,p.role,p.placeholders,p.source_path,p.created_at,p.updated_at,
      p.id = (SELECT v.id FROM prompt_templates v WHERE v.key=p.key AND v.enable=true ORDER BY v.updated_at DESC,v.id DESC LIMIT 1) AS current
    FROM prompt_templates p WHERE p.id=${id}
  `;
  if (!row) return null;
  const related = await sql<{ group_key:string; group_name:string; group_desc:string; id:string; key:string; name:string; enable:boolean; role:string }[]>`
    SELECT g.key AS group_key,g.name AS group_name,g."desc" AS group_desc,v.id::text AS id,v.key,v.name,v.enable,v.role
    FROM prompt_group_members own JOIN prompt_groups g ON g.key=own.group_key
    JOIN prompt_group_members sibling ON sibling.group_key=g.key
    JOIN LATERAL (SELECT p.* FROM prompt_templates p WHERE p.key=sibling.prompt_key ORDER BY p.enable DESC,p.updated_at DESC,p.id DESC LIMIT 1) v ON true
    WHERE own.prompt_key=${row.key} ORDER BY g.key,sibling.position,v.key
  `;
  return { row: { ...row, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() }, related: Array.from(related) };
}
export type PromptDetailData = NonNullable<Awaited<ReturnType<typeof getPromptDetail>>>;
