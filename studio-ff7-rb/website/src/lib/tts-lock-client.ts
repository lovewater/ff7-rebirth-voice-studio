"use client";

/** Native modal provides focus containment and Escape cancellation. Text is set
 * through DOM properties, never HTML, and real newlines remain editable. */
function confirmSubtitle(text: string, original: string): Promise<string | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.createElement("dialog");
    dialog.className = "m-auto w-[min(42rem,calc(100vw-1.5rem))] rounded-xl border border-zinc-700 bg-zinc-950 p-4 text-zinc-200 backdrop:bg-black/75 sm:p-5";
    dialog.setAttribute("aria-label", "确认字幕并锁定");
    const heading = document.createElement("h2");
    heading.className = "text-lg font-medium";
    heading.textContent = "确认字幕并锁定";
    const note = document.createElement("p");
    note.className = "mt-2 text-sm text-zinc-400";
    note.textContent = "TTS 文字与原字幕不同。请确认或修改下面的字幕，确认后将保存到“字幕改写”并锁定这条音频。";
    const source = document.createElement("p");
    source.className = "mt-3 whitespace-pre-wrap text-sm text-zinc-500";
    source.textContent = `原字幕：${original}`;
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "要同步的字幕");
    input.className = "mt-3 min-h-36 w-full rounded border border-zinc-700 bg-zinc-900 p-3 text-sm leading-6 outline-none focus:border-sky-600";
    input.value = text;
    const actions = document.createElement("div");
    actions.className = "mt-4 flex justify-end gap-2";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "inline-flex min-h-11 items-center rounded bg-zinc-800 px-4 text-sm";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "inline-flex min-h-11 items-center rounded bg-sky-700 px-4 text-sm text-white disabled:opacity-40";
    confirm.textContent = "确认同步并锁定";
    input.addEventListener("input", () => { confirm.disabled = !input.value.trim(); });
    const finish = (value: string | null) => {
      dialog.close(); dialog.remove(); previous?.focus(); resolve(value);
    };
    cancel.addEventListener("click", () => finish(null));
    confirm.addEventListener("click", () => { if (input.value.trim()) finish(input.value.trim()); });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(null); });
    // Prevent Escape bubbling into an underlying editor dialog.
    dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
    actions.append(cancel, confirm);
    dialog.append(heading, note, source, input, actions);
    document.body.append(dialog);
    dialog.showModal(); input.focus();
  });
}

type PatchResult = { error?: string; subtitleAutoFilled?: boolean; record?: { subtitle_text?: string | null } };

/** Every lock UI uses the same server-driven confirmation; cancellation is null.
 * First PATCH can return 409 without writes. Confirmed PATCH writes both fields
 * atomically, so cancelling never unlocks the previously adopted version. */
export async function patchTtsWithConfirmation(stem: string, id: string | number, body: Record<string, unknown>): Promise<PatchResult | null> {
  const send = (payload: Record<string, unknown>) => fetch(`/api/lines/${encodeURIComponent(stem)}/tts/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  let response = await send(body);
  let result = await response.json();
  if (response.status === 409 && result.code === "SUBTITLE_CONFIRMATION_REQUIRED") {
    const subtitleText = await confirmSubtitle(result.subtitleText, result.originalText);
    if (subtitleText === null) return null;
    response = await send({ ...body, subtitleText });
    result = await response.json();
  }
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  // Keep the detail input in sync with the exact text the user just confirmed.
  if (result.subtitleAutoFilled && result.record) {
    window.dispatchEvent(new CustomEvent("ff7-tts-subtitle-autofilled", {
      detail: { stem, text: result.record.subtitle_text ?? "" },
    }));
  }
  return result;
}
