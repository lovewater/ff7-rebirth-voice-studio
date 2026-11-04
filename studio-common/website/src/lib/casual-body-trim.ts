import { createHash } from "node:crypto";
import { inspectCasualBodyWav } from "./casual-body-audio";

const hash=(audio:Buffer)=>createHash("sha256").update(audio).digest("hex");

/** Crop external low-energy PCM only. No JP timing, interior cuts, padding or time stretching. */
export function trimCasualBodyEdges(input: Buffer) {
  const format=inspectCasualBodyWav(input);
  if (format.format_tag!==1 || format.bits_per_sample!==16) throw new Error("普通正文裁边需要PCM16");
  let at=12;
  while (input.toString("ascii",at,at+4)!=="data") at+=8+input.readUInt32LE(at+4)+(input.readUInt32LE(at+4)%2);
  const payload=input.subarray(at+8,at+8+format.frames*format.block_align);
  const amplitudes=new Uint16Array(format.frames);
  let peak=0;
  for(let frame=0;frame<format.frames;frame++) {
    let amplitude=0;
    for(let channel=0;channel<format.channels;channel++) amplitude=Math.max(amplitude,Math.abs(payload.readInt16LE(frame*format.block_align+channel*2)));
    amplitudes[frame]=amplitude;peak=Math.max(peak,amplitude);
  }
  const strongThreshold=Math.max(1,Math.ceil(peak*.05)),weakThreshold=Math.max(1,Math.ceil(peak*.001));
  let firstStrong=-1,lastStrong=-1,firstWeak=-1,lastWeak=-1,strongFrames=0;
  for(let frame=0;frame<format.frames;frame++) {
    if(amplitudes[frame]>=strongThreshold) {if(firstStrong<0)firstStrong=frame;lastStrong=frame;strongFrames++;}
    if(amplitudes[frame]>=weakThreshold) {if(firstWeak<0)firstWeak=frame;lastWeak=frame;}
  }
  const strongGuard=Math.ceil(format.sample_rate*.04),weakGuard=Math.ceil(format.sample_rate*.002);
  const valid=peak>0 && strongFrames>=Math.ceil(format.sample_rate*.02) && firstWeak>=0;
  let first=valid?Math.max(0,Math.min(firstStrong-strongGuard,firstWeak-weakGuard)):0;
  let end=valid?Math.min(format.frames,Math.max(lastStrong+1+strongGuard,lastWeak+1+weakGuard)):format.frames;
  const minimumTrim=Math.ceil(format.sample_rate*.005);
  if(first<minimumTrim)first=0;
  if(format.frames-end<minimumTrim)end=format.frames;
  if(end<=first){first=0;end=format.frames;}
  const changed=first>0 || end<format.frames;
  let audio=input;
  if(changed) {
    const body=payload.subarray(first*format.block_align,end*format.block_align);
    audio=Buffer.alloc(44+body.length);
    audio.write("RIFF");audio.writeUInt32LE(audio.length-8,4);audio.write("WAVEfmt ",8);audio.writeUInt32LE(16,16);
    audio.writeUInt16LE(1,20);audio.writeUInt16LE(format.channels,22);audio.writeUInt32LE(format.sample_rate,24);
    audio.writeUInt32LE(format.sample_rate*format.block_align,28);audio.writeUInt16LE(format.block_align,32);audio.writeUInt16LE(16,34);
    audio.write("data",36);audio.writeUInt32LE(body.length,40);body.copy(audio,44);
  }
  return {audio,changed,meta:{version:"casual-guarded-edge-trim-v1",reason:valid?changed?"仅移除受保护弱信号范围之外的首尾低能量空白":"首尾无需裁减":"有效发声证据不足，原字节保留",
    sampleRate:format.sample_rate,channels:format.channels,sourceFrames:format.frames,outputFrames:end-first,
    firstFrame:first,endFrame:end,strongThreshold,weakThreshold,strongGuardMs:40,weakGuardMs:2,strongActivityFrames:strongFrames,
    trimmedLeading:first/format.sample_rate,trimmedTrailing:(format.frames-end)/format.sample_rate,
    beforeDuration:format.duration_s,afterDuration:(end-first)/format.sample_rate,
    sourceSha256:hash(input),outputSha256:hash(audio),pcmExact:true}};
}
