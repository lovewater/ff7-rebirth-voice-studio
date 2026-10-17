import drafts from "./junon-rufus-drafts.json";

// 专题页的「比」与逐条页相同，除数是 beats.ts 的 NORMAL_JP_CN_RATIO。
// 1.00 是标准长度。本场收在 1.03–1.18；大于 1 中文偏短，小于 1 中文偏长。
// 这条收紧带是本场的目标，不随全局常数的测算口径自动改。
export const TARGET_RATIO = 1.1;
export const RATIO_LO = 1.03;
export const RATIO_HI = 1.18;

export const JUNON_DRAFTS: Record<string, string> = drafts;

export type TopicSection = { id: string; title: string; blurb: string };

const SPEECH: TopicSection = {
  id: "speech",
  title: "就职演讲",
  blurb: "海德格请路法斯上台，到总裁奖揭晓。",
};
const STAGE: TopicSection = {
  id: "stage",
  title: "点名上台",
  blurb: "点出第七步兵连队，主角团被叫上主席台。",
};
const REVEAL: TopicSection = {
  id: "reveal",
  title: "揭开头盔",
  blurb: "路法斯认出克劳德，让海德格退下。",
};
const DEAL: TopicSection = {
  id: "deal",
  title: "交易",
  blurb: "别靠近米德加，萨菲罗斯交给他们，交易成立。",
};
const YUFFIE: TopicSection = {
  id: "yuffie",
  title: "尤菲刺杀",
  blurb: "尤菲爬上炮台瞄准，巴雷特喝止。",
};
const OUT: TopicSection = {
  id: "out",
  title: "被路法斯赶走",
  blurb: "路法斯认定这是答案，主角团离开现场。",
};

const BY_SCENE: Record<string, TopicSection> = {
  "6000": SPEECH,
  "6100": STAGE,
  "6200": STAGE,
  "6300": REVEAL,
  "6500": DEAL,
  "6700": DEAL,
  "7105": DEAL,
  "6750": YUFFIE,
  "6800": YUFFIE,
  "6900": YUFFIE,
  "7103": YUFFIE,
  "7100": YUFFIE,
  "7110": YUFFIE,
  "7200": OUT,
};

const SCENE_ORDER = ["6000", "6100", "6200", "6300", "6500", "6700", "7105", "6750", "6800", "6900", "7103", "7100", "7110", "7200"];

export function sceneKey(stem: string) {
  return stem.split("_")[2] ?? "";
}

export function sectionOf(stem: string) {
  return BY_SCENE[sceneKey(stem)] ?? null;
}

export function topicOrder(stem: string) {
  const index = SCENE_ORDER.indexOf(sceneKey(stem));
  return index < 0 ? 999 : index;
}

export const TOPIC_SECTIONS = [SPEECH, STAGE, REVEAL, DEAL, YUFFIE, OUT];

export function draftFor(stem: string, textZh: string | null) {
  return JUNON_DRAFTS[stem] ?? textZh ?? "";
}
