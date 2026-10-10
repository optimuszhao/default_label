// 提示词诊断：在用户点“生成”之前给出改进建议（不阻止提交）。
import type { Preset, Recipe } from './presets.ts';

export interface LintHint {
  code: string;
  level: 'info' | 'warn';
  message: string;
  /** 一键修复：把正向里的否定短语移到反向 */
  fix?: { type: 'move-to-negative'; phrase: string; replacement: string };
}

/** 视频里常见的动作词（人物、物体、镜头） */
const ACTION_WORDS =
  /走|跑|飞|转|看|望|笑|哭|推|拉|摇|移|升|降|飘|流|落|跳|舞|游|打开|关上|吹|燃|奔|抬|挥|回头|靠近|远离|穿过|旋转|变化|移动|动|追|爬|坐下|站起|伸手|拥抱|倒下|洒落|冲向|滑行|摆动|眨眼|呼吸|翻滚|飞扬|涌动|绽放|融化|生长|坠|掠|俯冲|环绕|跟随|拍打|奔跑|行走|飞行|漂浮|下落|升起|展开|打开|闭上|转身|点头|招手|喝水|吃东西|弹奏|歌唱|书写|作画/;

/** 正向里写否定，模型往往反而会画出来 */
const NEGATION = /(不要|别有|别出现|不能有|没有|不带|去掉|无)([^，,。；;\s]{1,8})/g;

/** 明显互相矛盾的风格词 */
const STYLE_CONFLICTS: [RegExp, RegExp, string][] = [
  [/写实|真实照片|摄影/, /动漫|二次元|卡通/, '写实和动漫'],
  [/水墨|国画/, /赛博朋克|霓虹/, '水墨和赛博朋克'],
  [/黑白/, /色彩鲜艳|高饱和|多彩/, '黑白和高饱和'],
  [/白天|正午|阳光明媚/, /夜晚|深夜|月光/, '白天和夜晚'],
];

export function countActions(text: string): number {
  const clauses = text.split(/[，,。；;\n]/).filter((clause) => ACTION_WORDS.test(clause));
  return clauses.length;
}

export function lint(recipe: Recipe, options: { finalPrompt: string; presets: Preset[]; hasFirstFrame?: boolean; supportsNegative?: boolean } = { finalPrompt: '', presets: [] }): LintHint[] {
  const hints: LintHint[] = [];
  const text = recipe.text.trim();
  const usingTemplate = Boolean(recipe.templateId);
  const full = options.finalPrompt || text;

  if (!usingTemplate && text.length > 0 && text.length < 6) {
    hints.push({ code: 'too-short', level: 'warn', message: '提示词太短：写清楚主体、场景、光线和风格，效果会好很多' });
  }

  for (const match of text.matchAll(NEGATION)) {
    const phrase = match[0];
    hints.push({
      code: 'negation',
      level: 'warn',
      message: `正向提示词里写了“${phrase}”，模型可能反而画出来，建议移到反向提示词`,
      fix: options.supportsNegative === false ? undefined : { type: 'move-to-negative', phrase, replacement: match[2] },
    });
  }

  const styleText = `${full}，${options.presets
    .filter((preset) => preset.kind === 'style')
    .map((preset) => preset.name)
    .join('，')}`;
  for (const [a, b, label] of STYLE_CONFLICTS) {
    if (a.test(styleText) && b.test(styleText)) {
      hints.push({ code: 'style-conflict', level: 'warn', message: `同时出现了${label}，风格可能互相冲突` });
    }
  }

  if (recipe.mode === 'video') {
    const actions = countActions(full);
    const hasCamera = options.presets.some((preset) => preset.kind === 'camera');
    if (text && actions === 0 && !hasCamera) {
      hints.push({ code: 'video-no-action', level: 'warn', message: '视频提示词里没有动作：写清楚谁在做什么、镜头怎么动' });
    }
    const duration = recipe.overrides.duration ?? 5;
    if (duration >= 10 && actions <= 1 && text) {
      hints.push({ code: 'long-video-one-action', level: 'info', message: `${duration} 秒的视频只有一个动作，画面可能显得拖沓，可以写 2–3 个连贯动作` });
    }
    if (options.hasFirstFrame && text.length > 80 && actions <= 1) {
      hints.push({ code: 'i2v-restate', level: 'info', message: '图生视频不必复述首帧画面，重点描述画面怎么动' });
    }
  }
  return hints;
}

/** 执行“移到反向提示词” */
export function applyMoveToNegative(recipe: Recipe, phrase: string, replacement: string): Recipe {
  const text = recipe.text.replace(phrase, '').replace(/[，,]{2,}/g, '，').replace(/^[，,\s]+|[，,\s]+$/g, '');
  const negative = [recipe.negative.trim(), replacement].filter(Boolean).join('，');
  return { ...recipe, text, negative };
}
