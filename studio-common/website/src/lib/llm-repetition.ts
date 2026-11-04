export type RepetitionHit = {
  kind: "text" | "whitespace";
  pattern: string;
  patternLength: number;
  repetitions: number;
  endOffset: number;
};

/** 流式末尾连续 n-gram 检测，思路同 vLLM 的 RepetitionDetectionParams。
 * 按用户规则：任意长度片段连续出现10次就停，没有短词/拟声豁免。
 * 空格、换行、tab统一为一个空白符，因此混合空白循环也会停止。
 * 不按SSE包计数：一个包中重复十次、一个片段跨十个包，结果完全一致。
 *
 * runs[p]记录当前位置与前p字符相等的连续长度。达到9*p，且已有10*p字符，
 * 就证明末尾有十个相同的p字符块。每字符O(maxPatternLength)，仅保留有界环形缓冲；
 * 避免每收到一个token都重新扫描整篇思考，或让检测器自身占用不断增长的内存。
 */
export class RepetitionDetector {
  private readonly ring: string[];
  private readonly runs: Uint32Array;
  private count = 0;
  private pendingHighSurrogate = "";
  private detected: RepetitionHit | null = null;
  readonly repetitions: number;
  readonly maxPatternLength: number;

  constructor(repetitions = 10, maxPatternLength = 512) {
    if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 100
      || !Number.isInteger(maxPatternLength) || maxPatternLength < 1 || maxPatternLength > 4096) {
      throw new Error("重复检测参数无效");
    }
    this.repetitions = repetitions;
    this.maxPatternLength = maxPatternLength;
    this.ring = new Array(repetitions * maxPatternLength + 1);
    this.runs = new Uint32Array(maxPatternLength + 1);
  }

  private append(char: string): RepetitionHit | null {
    const value = /\s/u.test(char) ? " " : char;
    const index = this.count++;
    this.ring[index % this.ring.length] = value;
    for (let period = 1; period <= Math.min(this.maxPatternLength, index); period += 1) {
      const previous = this.ring[(index - period) % this.ring.length];
      this.runs[period] = value === previous ? this.runs[period] + 1 : 0;
      if (this.count >= period * this.repetitions && this.runs[period] >= period * (this.repetitions - 1)) {
        const pattern = Array.from({ length: period }, (_, n) =>
          this.ring[(this.count - period + n) % this.ring.length]).join("");
        this.detected = { kind: pattern.trim() ? "text" : "whitespace", pattern,
          patternLength: period, repetitions: this.repetitions, endOffset: this.count };
        return this.detected;
      }
    }
    return null;
  }

  push(chunk: string): RepetitionHit | null {
    if (this.detected) return this.detected;
    let text = this.pendingHighSurrogate + chunk;
    this.pendingHighSurrogate = "";
    // JSON delta有时会把emoji的两个UTF-16代理项分开发出；先拼好再按Unicode字符计数。
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.pendingHighSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    for (const char of text) {
      const hit = this.append(char);
      if (hit) return hit;
    }
    return null;
  }
}
