import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

export type CasualBodyWavFormat = {
  format_tag: number; encoding: number; sample_rate: number; channels: number;
  bits_per_sample: number; block_align: number; frames: number; duration_s: number;
};
const sha256 = (audio: Buffer) => createHash("sha256").update(audio).digest("hex");

/** Read actual received frames, including FFmpeg's terminal streaming data chunk. */
export function inspectCasualBodyWav(audio: Buffer): CasualBodyWavFormat {
  if (audio.length < 44 || audio.toString("ascii",0,4) !== "RIFF" || audio.toString("ascii",8,12) !== "WAVE")
    throw new Error("普通正文规范化需要完整WAV");
  let format: Omit<CasualBodyWavFormat,"frames"|"duration_s"> | undefined, dataBytes: number | undefined;
  for (let at=12;at+8<=audio.length;) {
    const name=audio.toString("ascii",at,at+4), size=audio.readUInt32LE(at+4);
    const end=name === "data" && size === 0xffffffff ? audio.length : at+8+size;
    if (end>audio.length) throw new Error("普通正文WAV块超出文件");
    if (name === "fmt ") {
      if (format || size<16) throw new Error("普通正文WAV格式块无效");
      const base=at+8, tag=audio.readUInt16LE(base);
      if (tag === 65534 && size<40) throw new Error("普通正文扩展WAV格式不完整");
      format={format_tag:tag,encoding:tag===65534?audio.readUInt32LE(base+24):tag,
        sample_rate:audio.readUInt32LE(base+4),channels:audio.readUInt16LE(base+2),
        bits_per_sample:audio.readUInt16LE(base+14),block_align:audio.readUInt16LE(base+12)};
    }
    if (name === "data") {
      if (dataBytes !== undefined) throw new Error("普通正文WAV含多个data块");
      dataBytes=end-at-8;
    }
    at=end+(size%2);
  }
  if (!format || ![1,3].includes(format.encoding) || !format.channels || !format.sample_rate
    || !format.bits_per_sample || format.bits_per_sample%8 || format.block_align!==format.channels*format.bits_per_sample/8
    || !dataBytes || dataBytes%format.block_align)
    throw new Error("普通正文WAV没有完整PCM或浮点音频帧");
  const frames=dataBytes/format.block_align;
  return {...format,frames,duration_s:frames/format.sample_rate};
}

/** Normalize before verification only; already canonical PCM must remain byte-identical. */
export async function normalizeCasualBodyWav(input: Buffer) {
  const sourceFormat=inspectCasualBodyWav(input), sourceSha256=sha256(input);
  const canonical=sourceFormat.format_tag===1 && sourceFormat.sample_rate===24000
    && sourceFormat.channels===1 && sourceFormat.bits_per_sample===16;
  const audio=canonical ? input : await new Promise<Buffer>((resolve,reject) => {
    const child=spawn("ffmpeg",["-hide_banner","-loglevel","error","-xerror","-i","pipe:0",
      "-ac","1","-ar","24000","-c:a","pcm_s16le","-f","wav","pipe:1"],{stdio:["pipe","pipe","pipe"]});
    const out: Buffer[]=[], errors: Buffer[]=[];
    child.stdout.on("data",chunk=>out.push(chunk));child.stderr.on("data",chunk=>errors.push(chunk));
    child.on("error",reject);
    child.stdin.on("error",reject);
    child.on("close",code=>code===0?resolve(Buffer.concat(out)):reject(new Error(Buffer.concat(errors).toString("utf8")||`ffmpeg ${code}`)));
    child.stdin.end(input);
  });
  const normalizedFormat=inspectCasualBodyWav(audio);
  if (normalizedFormat.format_tag!==1 || normalizedFormat.sample_rate!==24000
    || normalizedFormat.channels!==1 || normalizedFormat.bits_per_sample!==16)
    throw new Error("普通正文规范化未得到24k单声道PCM16");
  return {audio,changed:!canonical,sourceFormat,normalizedFormat,sourceSha256,normalizedSha256:sha256(audio)};
}
