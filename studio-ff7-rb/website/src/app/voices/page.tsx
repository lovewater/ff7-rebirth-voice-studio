import { sql } from "@/lib/db";
import { AutoSubmitForm } from "../lines/auto-submit-form";
import { SpeakerPicker, type SpeakerOpt } from "../lines/speaker-picker";
import { VoicePanel } from "./voice-panel";

export const dynamic = "force-dynamic";

function listParam(v: string | string[] | undefined): string[] {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

export default async function VoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ speaker?: string | string[]; slot?: string; who?: string }>;
}) {
  const sp = await searchParams;
  const speakers = listParam(sp.speaker);
  const slot = Math.max(1, parseInt(sp.slot ?? "1", 10) || 1);

  const speakerOpts = await sql<SpeakerOpt[]>`
    SELECT l.speaker,
           COALESCE(s.name_zh, l.speaker) AS speaker_name,
           COUNT(*)::int AS n,
           c.role
    FROM lines l
    LEFT JOIN speakers s ON s.code = l.speaker
    LEFT JOIN cast_members c ON c.speaker = l.speaker
    WHERE l.speaker IS NOT NULL AND l.speaker <> ''
    GROUP BY l.speaker, s.name_zh, c.role
    ORDER BY
      CASE c.role WHEN '主角' THEN 0 WHEN '配角' THEN 1 ELSE 2 END,
      n DESC
  `;
  const leads = speakerOpts.filter((s) => s.role === "主角");
  const supports = speakerOpts.filter((s) => s.role === "配角");
  const others = speakerOpts.filter((s) => s.role !== "主角" && s.role !== "配角");

  const who = sp.who && speakers.includes(sp.who) ? sp.who : speakers[0] ?? "";
  const focused = who;
  const focusedName =
    speakerOpts.find((s) => s.speaker === focused)?.speaker_name ?? focused;

  function voicesQs(code: string) {
    const u = new URLSearchParams();
    for (const s of speakers) u.append("speaker", s);
    u.set("who", code);
    if (slot !== 1) u.set("slot", String(slot));
    return `/voices?${u.toString()}`;
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <AutoSubmitForm action="/voices" method="get" className="flex flex-col gap-3">
        <SpeakerPicker
          leads={leads}
          supports={supports}
          others={others}
          selected={focused ? [focused] : []}
          single
        />
      </AutoSubmitForm>

      {speakers.length > 1 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {speakers.map((code) => (
            <a
              key={code}
              href={voicesQs(code)}
              className={`rounded border px-2 py-0.5 text-xs ${
                code === focused
                  ? "border-zinc-400 bg-zinc-800 text-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {speakerOpts.find((s) => s.speaker === code)?.speaker_name ?? code}
            </a>
          ))}
        </div>
      ) : null}

      {focused ? (
        <VoicePanel key={`${focused}:${slot}`} speaker={focused} name={focusedName} slot={slot} speakers={speakers} />
      ) : (
        <p className="mt-8 text-sm text-zinc-500">选一个人物后，下面才出现参考音色。</p>
      )}
    </main>
  );
}
