export default function PackPage() {
  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">打包差量</h1>
      <p className="mt-2 text-zinc-500">
        差量包 <code>aa_cn_voice_edit_P</code> 暂缓。Linux 封包未完成，必要时在 Win11 上打。
        现在用区域页和逐条页预览数据。人物名和台词附加信息在 Postgres 的
        <code>speakers</code> / <code>line_meta</code>，不会打进语音包。
      </p>
    </main>
  );
}
