// 故事模板（STY-12）：新建故事时选一个，带好比例、画风、基调和章节场次骨架。
// 绘本类模板隐藏视频相关的步骤和按钮，最后一步换成图文排版。
import type { StoryData } from './types.ts';

export interface StoryTemplate {
  id: string;
  name: string;
  description: string;
  /** 不需要视频（绘本、漫画） */
  imageOnly?: boolean;
  /** 默认的图文版式 */
  layout?: 'picture_book' | 'four_panel' | 'webtoon';
  settings: Partial<Pick<StoryData, 'genre' | 'tone' | 'visualStyle' | 'aspectRatio' | 'negativePrompt' | 'targetDuration'>>;
  /** 章 → 场 的骨架（只有标题和提示） */
  skeleton: { title: string; summary?: string; scenes: { title: string; summary?: string }[] }[];
}

export const STORY_TEMPLATES: StoryTemplate[] = [
  {
    id: 'vertical-drama',
    name: '竖屏短剧',
    description: '9:16 竖屏，节奏快，每集 1–2 分钟，开头 3 秒就要有钩子。',
    settings: { aspectRatio: '9:16', genre: '都市', tone: '冲突强烈，反转密集', visualStyle: '写实电影感，浅景深，高对比度', targetDuration: 90 },
    skeleton: [
      {
        title: '第一集',
        scenes: [
          { title: '钩子', summary: '开场 3 秒：最强冲突或悬念直接抛出' },
          { title: '起因', summary: '交代人物关系和矛盾的来源' },
          { title: '反转', summary: '局面突然逆转' },
          { title: '悬念结尾', summary: '留下让人想看下一集的问题' },
        ],
      },
    ],
  },
  {
    id: 'music-video',
    name: 'MV',
    description: '跟着音乐分段：主歌、副歌、桥段，画面重氛围和节奏。',
    settings: { aspectRatio: '16:9', tone: '情绪化，富有诗意', visualStyle: '电影级调色，柔光，胶片颗粒', targetDuration: 210 },
    skeleton: [
      { title: '主歌一', scenes: [{ title: '人物与环境' }, { title: '情绪铺垫' }] },
      { title: '副歌', scenes: [{ title: '情绪爆发' }, { title: '标志性画面' }] },
      { title: '桥段', scenes: [{ title: '回忆 / 转折' }] },
      { title: '尾声', scenes: [{ title: '收束' }] },
    ],
  },
  {
    id: 'picture-book',
    name: '儿童绘本',
    description: '只出图不出视频，每页一张画配一段文字，最后排版导出长图或打印。',
    imageOnly: true,
    layout: 'picture_book',
    settings: { aspectRatio: '4:3', genre: '童话', tone: '温暖，童趣', visualStyle: '儿童绘本插画，水彩质感，柔和的色彩，圆润的造型', negativePrompt: '恐怖，血腥，写实照片' },
    skeleton: [
      { title: '开始', scenes: [{ title: '认识主角' }, { title: '出发' }] },
      { title: '冒险', scenes: [{ title: '遇到困难' }, { title: '朋友帮忙' }] },
      { title: '结局', scenes: [{ title: '回家' }] },
    ],
  },
  {
    id: 'product-ad',
    name: '产品广告',
    description: '15–30 秒：痛点 → 产品亮相 → 卖点 → 号召行动。',
    settings: { aspectRatio: '16:9', tone: '明快，高级', visualStyle: '商业广告摄影，干净的背景，精致的产品光', targetDuration: 30 },
    skeleton: [
      {
        title: '广告',
        scenes: [{ title: '痛点', summary: '用户遇到的问题' }, { title: '产品亮相' }, { title: '卖点展示', summary: '2–3 个核心卖点' }, { title: '品牌与号召', summary: 'Logo、口号、购买方式' }],
      },
    ],
  },
  {
    id: 'motion-comic',
    name: '动态漫',
    description: '漫画分格的画面加轻微运镜和台词，适合连载。',
    layout: 'four_panel',
    settings: { aspectRatio: '9:16', genre: '热血', tone: '紧凑', visualStyle: '日式动漫风格，线条清晰，赛璐璐上色' },
    skeleton: [{ title: '第一话', scenes: [{ title: '开场' }, { title: '冲突' }, { title: '高潮' }, { title: '下回预告' }] }],
  },
  {
    id: 'trailer',
    name: '预告片',
    description: '60–90 秒：世界观 → 主角 → 危机 → 高燃剪辑 → 片名。',
    settings: { aspectRatio: '21:9', tone: '史诗，紧张', visualStyle: '好莱坞大片质感，宽银幕，冷暖对比，体积光', targetDuration: 75 },
    skeleton: [{ title: '预告', scenes: [{ title: '世界观' }, { title: '主角登场' }, { title: '危机降临' }, { title: '高燃快剪' }, { title: '片名与上映信息' }] }],
  },
];

export function findTemplate(id: string | null | undefined): StoryTemplate | null {
  return STORY_TEMPLATES.find((template) => template.id === id) ?? null;
}
