import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/** 音频统一支持字节范围：手机媒体引擎可能先探测bytes=0-1，再请求后续数据。
 * 不能忽略Range直接200整文件，必须提供准确的206/Content-Range/Content-Length。
 * 仅支持单范围；多范围和其他单位按HTTP允许的方式忽略并返回完整文件。
 */
export async function audioFileResponse(req: Request, file: string, options: {
  contentType: string;
  cacheControl?: string;
  headers?: HeadersInit;
}): Promise<Response> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return new Response("audio not found", { status: 404 });
    size = info.size;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return new Response("audio not found", { status: 404 });
    throw error;
  }
  const headers = new Headers(options.headers);
  headers.set("Content-Type", options.contentType);
  headers.set("Cache-Control", options.cacheControl ?? "private, no-store");
  headers.set("Accept-Ranges", "bytes");
  let start = 0;
  let end = size - 1;
  let status = 200;
  // 没有验证器可比较If-Range时返回完整新文件；HEAD只返回完整资源的响应头。
  const range = req.method === "HEAD" || req.headers.has("if-range") ? null : req.headers.get("range")?.trim();
  if (range && /^bytes=/i.test(range) && !range.includes(",")) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    let valid = !!match && !!(match[1] || match[2]) && size > 0;
    if (valid && match) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : end;
        valid = Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd) && start < size && requestedEnd >= start;
        end = Math.min(requestedEnd, end);
      }
    }
    if (!valid) {
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (req.method === "HEAD" || size === 0) return new Response(null, { status, headers });
  const stream = createReadStream(file, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}
