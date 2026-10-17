/** 读取OpenAI兼容SSE，正确处理UTF-8/JSON跨网络包、CRLF、注释心跳和多行data。
 * onData返回false或抛错会立即cancel reader，而不是把剩余生成偷偷读完。
 * onRaw只收实际收到的原文，用于数据库逐次回放；不包含HTTP认证头。
 */
export async function consumeLlmSse(body: ReadableStream<Uint8Array>,
  onData: (data: string) => boolean, onRaw: (text: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let stopped = false;
  const line = (value: string) => {
    if (value === "") {
      if (data.length) {
        const frame = data.join("\n");
        data = [];
        if (!onData(frame)) stopped = true;
      }
    } else if (value === "data" || value.startsWith("data:")) {
      const field = value === "data" ? "" : value.slice(5);
      data.push(field.startsWith(" ") ? field.slice(1) : field);
    }
  };
  const process = (final = false) => {
    let start = 0;
    for (let i = 0; i < buffer.length && !stopped; i += 1) {
      if (buffer[i] !== "\n" && buffer[i] !== "\r") continue;
      if (buffer[i] === "\r" && i === buffer.length - 1 && !final) break;
      line(buffer.slice(start, i));
      if (buffer[i] === "\r" && buffer[i + 1] === "\n") i += 1;
      start = i + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > 1_048_576 || data.reduce((n, s) => n + s.length, 0) > 1_048_576) {
      throw new Error("模型SSE单个事件过长");
    }
    if (final && !stopped) { if (buffer) line(buffer); buffer = ""; line(""); }
  };
  try {
    while (!stopped) {
      const { value, done } = await reader.read();
      const text = decoder.decode(value, { stream: !done });
      if (text) { onRaw(text); buffer += text; }
      process(done);
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
