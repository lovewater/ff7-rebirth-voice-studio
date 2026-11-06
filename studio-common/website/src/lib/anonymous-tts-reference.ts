import { createHash } from "node:crypto";

export type AnonymousTtsReference = {
  version: "anonymous-self-reference-v1";
  stem: string;
  context: "none";
  source_audio_path: string;
  source_audio_sha256: string;
  reference_audio_path: string;
  reference_audio_sha256: string;
};

/** 人物未知时仅克隆本句，不把同样未知的邻句当成同人物，也不编造人物记录。
 * 普通对话仍由完整总长流程负责处理、核字、三次起稿及改稿，不能在此直接判通过。
 * 清理参考必须是当前run已登记的、本句目录中的参考；调用方不能换另一句音色。
 */
export function anonymousTtsReference(input: {
  stem: string; promptStem: string; promptLang: "jp" | "cn";
  promptPath: string; registeredReference: string | null;
  japanese: Buffer; prompt: Buffer; expectedJapaneseSha256?: string;
}): AnonymousTtsReference {
  const { stem, promptStem, promptLang, promptPath, registeredReference } = input;
  const source = `jp/${stem}.mp3`;
  const ownRunReference = promptPath === registeredReference && promptPath.startsWith(`tts/${stem}/`)
    && !promptPath.split("/").includes("..");
  if (promptStem !== stem || promptLang !== "jp" || (promptPath !== source && !ownRunReference))
    throw new Error("人物未知的台词只能使用本句日文原声或当前流程登记的本句参考");
  if (!input.japanese.length || !input.prompt.length) throw new Error("本句日文参考为空");
  const hash = (audio: Buffer) => createHash("sha256").update(audio).digest("hex");
  const sourceSha = hash(input.japanese);
  if (input.expectedJapaneseSha256 && sourceSha !== input.expectedJapaneseSha256)
    throw new Error("本句日文原声与导入来源不一致");
  return { version: "anonymous-self-reference-v1", stem, context: "none",
    source_audio_path: source, source_audio_sha256: sourceSha,
    reference_audio_path: promptPath, reference_audio_sha256: hash(input.prompt) };
}
