import { alignmentDetectionSignal } from "./alignment-transients";
import { decodeWavMono } from "./wav-stretch";
import { TWO_PART_CN_GAP_S } from "./gap-only-align";
/** 仅正文内部使用其实际缩放系数；重新填充的段间静音不属于任何区域。 */
export type SpeechSplitRegion = { startSeconds: number; endSeconds: number; factor: number };
export type SpeechChunk = { start: number; end: number };
/** 与旧分隔器相同的峰值5%、10ms窗；仅入口日文500ms，中文仍按250ms拆。
 * 所有声音按原顺序保留；首尾静音不算内部段，不能以ASR时间戳替代波形切口。
 */
export function speechChunks(audio: Buffer, minimumSeconds = TWO_PART_CN_GAP_S, regions: SpeechSplitRegion[] = []) {
  const wave = decodeWavMono(audio), { sampleRate } = wave;
  // 仅检测副本忽略孤立弱凸起；wave保留原PCM，后续切片/拉伸不使用检测副本。
  const { samples, peak } = alignmentDetectionSignal(wave.samples, sampleRate);
  if(peak<=1e-8)return {wave,chunks:[] as SpeechChunk[]};
  const threshold=peak*.05,hop=Math.max(1,Math.round(sampleRate*.01));
  let start=0,end=samples.length;
  while(start<end && Math.abs(samples[start])<threshold)start++;
  while(end>start && Math.abs(samples[end-1])<threshold)end--;
  const chunks:SpeechChunk[]=[],minimum=Math.ceil(sampleRate*minimumSeconds);
  let quiet:number|null=null,bodyStart=start;
  for(let at=Math.floor(start/hop)*hop;at<end+hop;at+=hop){
    let silent=at<samples.length;
    for(let i=at;i<Math.min(at+hop,samples.length);i++)if(Math.abs(samples[i])>=threshold){silent=false;break;}
    if(silent && quiet===null)quiet=at;
    if(!silent && quiet!==null){
      // 只有完整落在同一段正文内的静音才缩放门槛。跨正文边界的静音仍用250ms。
      // 10ms窗和变速边缘有量化误差，缩放区域额外容许两个检测窗（20ms）；原始检测不放宽。
      const region=regions.find(r=>quiet!/sampleRate>=r.startSeconds-.01 && at/sampleRate<=r.endSeconds+.01 && r.factor>0 && Number.isFinite(r.factor));
      const localMinimum=region && Math.abs(region.factor-1)>1e-8 ? Math.ceil(sampleRate*minimumSeconds*region.factor)+2*hop : minimum;
      if(at-quiet>=localMinimum && quiet>start && at<end){chunks.push({start:bodyStart,end:quiet});bodyStart=at;}
      quiet=null;
    }
  }
  chunks.push({start:bodyStart,end});return {wave,chunks};
}
