/** 按播放入口的点击/请求计数，不等媒体成功、不重试上报，避免重复加次数。
 * 原生音频控件按点击计；自动连播按每条开始播放计；编辑预览归到其源音频记录。
 */
export async function reportTtsPlayback(stem: string, id: string | number): Promise<boolean> {
  try {
    const response = await fetch(`/api/lines/${encodeURIComponent(stem)}/tts/${id}/heard`, { method: "POST", keepalive: true });
    if (!response.ok) return false;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("ff7-tts-changed"));
      try {
        const channel = new BroadcastChannel("ff7-tts-changed");
        channel.postMessage({ at: Date.now() });
        channel.close();
      } catch { /* 不支持跨页通知不影响计数 */ }
    }
    return true;
  } catch { return false; }
}

export function ttsPlaybackIdentity(source: string) {
  try {
    const url = new URL(source, "http://local");
    if (url.searchParams.get("kind") === "reference") return null;
    const match = url.pathname.match(/^\/api\/lines\/([^/]+)\/tts\/(\d+)\/audio$/);
    if (!match) return null;
    return { stem: decodeURIComponent(match[1]), id: match[2] };
  } catch { return null; }
}
export function reportTtsPlaybackSource(source: string) {
  const record = ttsPlaybackIdentity(source);
  if (record) void reportTtsPlayback(record.stem, record.id);
}
