// AI 创作助手：提示词润色、故事大纲、角色、章节场次、台词、分镜。
// http 模式下调用同事提供的 LLM 接口（要求返回 JSON）；mock 模式下返回模板化的示例，
// 方便在没有大模型的情况下把整个创作流程走通。
import { OFFLINE_IDEAS } from '../shared/seed.ts';
import type { AssistKind } from '../shared/types.ts';
import { openAiChat } from './providers/llm.ts';
import { useMockAssist } from './providers/index.ts';

type Dict = Record<string, unknown>;

const SYSTEM = `你是一名资深影视编剧兼分镜师，擅长为 AI 视频生成模型撰写剧本与分镜。
始终只输出一个合法 JSON 对象，不要输出 markdown 代码块或任何解释文字。`;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function buildPrompt(kind: AssistKind, input: Dict): string {
  const json = JSON.stringify(input, null, 2);
  switch (kind) {
    case 'polish':
      return `把下面的${input.mode === 'video' ? '视频' : '图片'}生成提示词改写得更具体、更有画面感：补充主体、环境、光线、构图、镜头语言、风格，保持原意，中文输出，150 字以内。
输入：${json}
输出格式：{"prompt": "..."}`;
    case 'outline':
      return `根据一句话故事和设定，写一份完整的故事大纲：包含世界观、主要冲突、起承转合与结局，分段落，600~1200 字。
输入：${json}
输出格式：{"title": "片名", "outline": "大纲正文"}`;
    case 'characters':
      return `根据故事大纲设计 3~6 个主要角色。appearance 字段要写成可直接用于 AI 绘图的外貌描述（年龄、发型、服装、体态、标志性特征），以保持角色在不同镜头中的一致性。
输入：${json}
输出格式：{"characters": [{"name": "", "role": "主角/配角/反派", "appearance": "", "personality": ""}]}`;
    case 'chapters':
      return `把故事大纲拆分为 ${input.chapterCount ?? 3} 个章节，每章 ${input.scenesPerChapter ?? 3} 个场次。每个场次写清地点、时间和剧情段落（剧本式描述，100~200 字）。
输入：${json}
输出格式：{"chapters": [{"title": "", "summary": "", "scenes": [{"title": "", "location": "", "time": "", "summary": ""}]}]}`;
    case 'dialogue':
      return `为这个场次写台词对白。character 填角色名，旁白填 "旁白"。台词要口语化、推动剧情，6~14 句。
输入：${json}
输出格式：{"dialogue": [{"character": "", "text": "", "emotion": ""}]}`;
    case 'expand':
      return `把下面的${input.mode === 'video' ? '视频' : '图片'}提示词扩写成 80~160 字。按“主体与动作 → 环境与时间 → 构图与镜头 → 光线与色彩 → 风格”的顺序组织${input.mode === 'video' ? '；视频只写 1~3 个连贯的动作' : ''}。保持原意，中文输出。
输入：${json}
输出格式：{"prompt": "..."}`;
    case 'translate':
      return `把下面的提示词翻译成${input.to === 'zh' ? '中文' : '英文'}，适合 AI 绘图模型理解。花括号里的变量（例如 {主体}）必须原样保留，不要翻译也不要删除。
输入：${json}
输出格式：{"prompt": "..."}`;
    case 'variants':
      return `基于下面的提示词写 4 个变体，每个变体只改变一个维度（例如：时间、天气、视角、风格），并说明改了哪里。
输入：${json}
输出格式：{"variants": [{"change": "改了什么", "prompt": "..."}]}`;
    case 'fill':
      return `用户想要：${str(input.idea)}。请为下面这个提示词模板的每个变量填写合适的中文取值（简短具体，每个不超过 20 字）。
模板：${str(input.body)}
变量：${JSON.stringify(input.variables)}
输出格式：{"vars": {"变量名": "取值"}}`;
    case 'motion':
      return `这是一张静态画面的描述：${str(input.prompt)}。为把它做成 5~10 秒的视频，给出 3 个动作方案：轻微、中等、戏剧性各一个，每个写成一句可直接用于视频生成的动作描述，并从这些运镜里选一个最合适的：固定镜头、缓慢推进、缓慢拉远、左摇、右摇、环绕、跟拍、升镜头、降镜头。
输出格式：{"motions": [{"level": "轻微", "prompt": "...", "camera": "缓慢推进"}]}`;
    case 'inspire':
      return `给出 4 个有画面感、适合 AI ${input.mode === 'video' ? '视频' : '绘图'}的创作点子，每个一句话，题材尽量不同。
输出格式：{"ideas": ["..."]}`;
    case 'recap':
      return `为这一章写一段前情提要（150~300 字），交代到本章结束时的人物处境、关键事件和悬念，给后面的章节当上下文。previous 是之前各章（或上一集）的提要。
输入：${json}
输出格式：{"recap": "..."}`;
    case 'extract':
      return `从下面的剧本里提取设定：角色（appearance 写成可直接用于 AI 绘图的外貌描述）、地点（snippet 写环境描述）、关键道具（snippet 写外观描述）。只提取剧本里明确出现的。
输入：${json}
输出格式：{"characters": [{"name": "", "role": "", "appearance": ""}], "locations": [{"name": "", "snippet": ""}], "props": [{"name": "", "snippet": ""}]}`;
    case 'split':
      return `把下面的原著长文拆成 ${input.chapterCount ?? '合适数量的'} 个章节。每章给出标题、梗概（100~200 字），以及这一章在原文中开头的一句话（firstSentence，必须原样摘自原文）。
输入：${json}
输出格式：{"chapters": [{"title": "", "summary": "", "firstSentence": ""}]}`;
    case 'split_shots':
      return `把这个想法拆成 ${input.count ?? 4} 个连贯的镜头，组成一个短片。每个镜头写画面描述（可直接用于 AI 绘图）和动作描述（可直接用于图生视频），时长 4~8 秒。
输入：${json}
输出格式：{"shots": [{"description": "", "motion": "", "duration": 5}]}`;
    case 'shots':
      return `为这个场次设计分镜，4~10 个镜头。description 写成可直接用于 AI 视频生成的画面描述（主体、动作、环境、光线），每个镜头 3~8 秒。
shotSize 取值：远景/全景/中景/近景/特写；cameraMove 取值：固定/推/拉/摇/移/跟/环绕/升降。
dialogueIndexes 为该镜头对应台词在输入 dialogue 数组中的下标；characterNames 为出镜角色名。
输入：${json}
输出格式：{"shots": [{"shotSize": "", "cameraMove": "", "description": "", "duration": 5, "dialogueIndexes": [], "characterNames": []}]}`;
  }
}

function parseJsonLoose(text: string): Dict {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed) as Dict;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as Dict;
    throw new Error('大模型返回的内容不是合法 JSON');
  }
}

/** 长文本类输入截断，控制上下文在约 6000 token 以内 */
function clip(kind: AssistKind, input: Dict): Dict {
  const out = { ...input };
  if (kind === 'split' && typeof out.source === 'string') out.source = out.source.slice(0, 12_000);
  if (kind === 'extract' && typeof out.script === 'string') out.script = out.script.slice(0, 10_000);
  if (kind === 'recap' && Array.isArray(out.previous)) out.previous = (out.previous as unknown[]).slice(-5);
  return out;
}

export async function runAssist(kind: AssistKind, rawInput: Dict): Promise<Dict> {
  const input = clip(kind, rawInput);
  if (useMockAssist()) return mockAssist(kind, input);
  if (kind === 'translate' && typeof input.prompt === 'string') {
    // 变量保护：翻译前把 {变量} 换成占位符，翻译后换回来，防止模型改动
    const vars: string[] = [];
    const masked = input.prompt.replace(/\{([^{}\s]{1,16})\}/g, (match) => `[[V${vars.push(match) - 1}]]`);
    const result = await runAssist('translate-raw' as AssistKind, { ...input, prompt: masked });
    const text = str(result.prompt).replace(/\[\[V(\d+)\]\]/g, (_, index: string) => vars[Number(index)] ?? '');
    return { prompt: text };
  }
  const content = await openAiChat(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildPrompt((kind as string) === 'translate-raw' ? 'translate' : kind, input) },
    ],
    { json: true, temperature: kind === 'polish' || (kind as string) === 'translate-raw' ? 0.4 : 0.85 },
  );
  return parseJsonLoose(content);
}

/** LLM 不可用时的离线灵感：从词库随机拼 */
export function offlineInspire(mode: unknown): Dict {
  const pickRandom = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  const ideas = Array.from({ length: 4 }, () => {
    const subject = pickRandom(OFFLINE_IDEAS.subjects);
    const place = pickRandom(OFFLINE_IDEAS.places);
    const mood = pickRandom(OFFLINE_IDEAS.moods);
    return mode === 'video' ? `${subject}在${place}${pickRandom(OFFLINE_IDEAS.actions)}，${mood}的氛围` : `${place}的${subject}，${mood}的氛围`;
  });
  return { ideas, offline: true };
}

// ---------------- mock ----------------

const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'];
const MOVES = ['固定', '推', '拉', '摇', '移', '跟', '环绕', '升降'];
const EMOTIONS = ['平静', '坚定', '迟疑', '激动', '低语', '愤怒', '释然'];

function pick<T>(list: T[], index: number): T {
  return list[index % list.length];
}

function mockAssist(kind: AssistKind, input: Dict): Dict {
  switch (kind as string) {
    case 'expand': {
      const base = str(input.prompt, '一座漂浮在云海之上的未来城市');
      return {
        prompt:
          input.mode === 'video'
            ? `${base}，人物缓缓转身看向远方，镜头慢慢推近；黄昏时分，远处城市灯火初亮；中景构图；暖色逆光勾勒轮廓；电影感`
            : `${base}，位于画面中央；清晨薄雾中的城市边缘；三分法构图，低角度仰拍；柔和的侧逆光与冷暖对比；写实电影质感，细节丰富`,
      };
    }
    case 'translate':
    case 'translate-raw': {
      const text = str(input.prompt);
      return { prompt: input.to === 'zh' ? `（译）${text}` : `[EN] ${text}` };
    }
    case 'variants': {
      const base = str(input.prompt, '海边的灯塔');
      return {
        variants: [
          { change: '时间改为夜晚', prompt: `${base}，深夜，星空与月光` },
          { change: '天气改为暴雨', prompt: `${base}，暴雨，海浪翻涌` },
          { change: '视角改为航拍', prompt: `${base}，无人机俯拍视角` },
          { change: '风格改为水彩', prompt: `${base}，水彩画风格` },
        ],
      };
    }
    case 'fill': {
      const variables = Array.isArray(input.variables) ? (input.variables as { key: string; default?: string }[]) : [];
      const idea = str(input.idea, '');
      return { vars: Object.fromEntries(variables.map((v, index) => [v.key, index === 0 && idea ? idea.slice(0, 20) : (v.default ?? '')])) };
    }
    case 'motion':
      return {
        motions: [
          { level: '轻微', prompt: '人物轻轻眨眼，发丝随风微动，光影缓慢变化', camera: '固定镜头' },
          { level: '中等', prompt: '人物转头看向远处，衣摆被风吹起，背景云层流动', camera: '缓慢推进' },
          { level: '戏剧性', prompt: '狂风骤起，人物张开双臂，周围的花瓣旋转飞舞', camera: '环绕' },
        ],
      };
    case 'inspire':
      return offlineInspire(input.mode);
    case 'polish': {
      const base = str(input.prompt, '一座漂浮在云海之上的未来城市');
      const extra =
        input.mode === 'video'
          ? '，电影级镜头，缓慢推镜，体积光穿过薄雾，人物动作自然连贯，24fps，景深浅，色调冷暖对比'
          : '，主体居中，戏剧性侧逆光，丰富的细节与材质，超高清，电影感构图，色彩层次分明';
      return { prompt: base.includes('电影') ? base : base + extra };
    }
    case 'outline': {
      const logline = str(input.logline, '一个少女在废墟城市中寻找失落的声音');
      return {
        title: str(input.title, '回声之城'),
        outline: [
          `【世界观】${logline}。故事发生在一个被${str(input.genre, '科幻')}气息笼罩的近未来，城市在一次“静默事件”后失去了所有声音。`,
          '【开端】主角在废墟中发现一台仍能发出声音的旧式收音机，收音机里传来一段求救信号，指引她前往城市中心的钟塔。',
          '【发展】途中她结识了沉默寡言的机械师与一只会模仿人声的机械鸟，三人穿过被封锁的地铁隧道、漂浮的集市与倒悬的图书馆，逐渐拼凑出静默事件的真相。',
          '【高潮】钟塔顶端，掌控城市的“守静者”现身——原来静默是他为了掩盖一场灾难而制造的。主角必须在恢复声音与维持秩序之间做出抉择。',
          `【结局】她选择让声音回归，城市在久违的喧嚣中苏醒。基调：${str(input.tone, '温暖而带着忧伤')}。`,
        ].join('\n\n'),
      };
    }
    case 'characters':
      return {
        characters: [
          { name: '林昔', role: '主角', appearance: '17 岁少女，齐肩黑色短发，琥珀色眼睛，穿宽大的米色工装外套和红色围巾，背着旧收音机', personality: '倔强、好奇、善于倾听' },
          { name: '阿铁', role: '配角', appearance: '30 岁男性机械师，高大，络腮胡，灰色连体工作服沾满油污，左臂为黄铜机械义肢', personality: '沉默寡言，外冷内热' },
          { name: '啾', role: '配角', appearance: '巴掌大的黄铜机械鸟，翅膀由齿轮与薄铜片构成，眼睛发出蓝色微光', personality: '调皮，会模仿各种声音' },
          { name: '守静者', role: '反派', appearance: '身形瘦长的中年人，银白长发，穿黑色高领长袍，面戴半透明玻璃面具', personality: '冷静、偏执，自认为是城市的守护者' },
        ],
      };
    case 'chapters': {
      const chapterCount = Math.min(Number(input.chapterCount) || 3, 8);
      const scenesPer = Math.min(Number(input.scenesPerChapter) || 3, 8);
      const chapterTitles = ['静默之城', '地下回响', '漂浮集市', '倒悬图书馆', '钟塔之巅', '声音归来', '余音', '新生'];
      const places = ['废墟街道', '地铁隧道', '漂浮集市', '倒悬图书馆', '钟塔内部', '城市广场', '天台', '旧电台'];
      const times = ['黄昏', '深夜', '清晨', '正午', '雨夜'];
      return {
        chapters: Array.from({ length: chapterCount }, (_, c) => ({
          title: `第${c + 1}章 · ${pick(chapterTitles, c)}`,
          summary: `本章围绕“${pick(chapterTitles, c)}”展开，主角在${pick(places, c)}遭遇新的线索与阻碍。`,
          scenes: Array.from({ length: scenesPer }, (_, s) => ({
            title: `场次 ${c + 1}-${s + 1}`,
            location: pick(places, c + s),
            time: pick(times, c * 2 + s),
            summary: `${pick(times, c * 2 + s)}的${pick(places, c + s)}，林昔与同伴小心前行。远处传来断续的声音，她停下脚步，把收音机贴近耳边——信号越来越清晰，指向了下一个目的地。`,
          })),
        })),
      };
    }
    case 'dialogue': {
      const names = Array.isArray(input.characterNames) && input.characterNames.length
        ? (input.characterNames as string[])
        : ['林昔', '阿铁'];
      const lines = [
        '你听到了吗？就在那边。',
        '这座城市已经很久没有声音了。',
        '收音机里的信号又变强了。',
        '别走太快，前面的路不稳。',
        '如果我们找到钟塔，一切就会结束吗？',
        '也许，一切才刚刚开始。',
        '跟紧我。',
        '……我好像听见了心跳的声音。',
      ];
      return {
        dialogue: [
          { character: '旁白', text: str(input.sceneSummary, '夜色笼罩着沉默的街道。').slice(0, 40), emotion: '平静' },
          ...lines.map((text, index) => ({ character: pick(names, index), text, emotion: pick(EMOTIONS, index) })),
        ],
      };
    }
    case 'recap': {
      const title = str(input.chapterTitle, '本章');
      const previous = Array.isArray(input.previous) && input.previous.length ? '承接前情，' : '';
      return { recap: `${previous}${title}结束时，主角已经拿到关键线索，却也暴露了行踪；同伴之间产生分歧，远处的钟塔再次传来异响，新的危险正在逼近。` };
    }
    case 'extract': {
      const script = str(input.script);
      const names = [...new Set([...script.matchAll(/([\u4e00-\u9fa5]{2,3})[：:]/g)].map((m) => m[1]))].filter((n) => n !== '旁白').slice(0, 6);
      return {
        characters: (names.length ? names : ['林昔']).map((name, i) => ({ name, role: i === 0 ? '主角' : '配角', appearance: '' })),
        locations: [{ name: '废墟街道', snippet: '残破的高楼，积水倒映霓虹，薄雾弥漫' }],
        props: [{ name: '旧收音机', snippet: '掉漆的木壳收音机，指示灯泛着橙光' }],
      };
    }
    case 'split': {
      const source = str(input.source);
      const parts = source.split(/\n{2,}|(?=第[一二三四五六七八九十百\d]+[章回节])/).map((p) => p.trim()).filter(Boolean);
      const count = Math.min(Number(input.chapterCount) || Math.min(Math.max(parts.length, 1), 8), 20);
      const per = Math.max(1, Math.ceil(parts.length / count));
      return {
        chapters: Array.from({ length: Math.min(count, Math.max(1, Math.ceil(parts.length / per))) }, (_, i) => {
          const chunk = parts.slice(i * per, (i + 1) * per).join('\n');
          return { title: `第${i + 1}章`, summary: chunk.slice(0, 120), firstSentence: chunk.split(/[。！？\n]/)[0] ?? '' };
        }),
      };
    }
    case 'split_shots': {
      const idea = str(input.idea, '雨夜街头的少女');
      const count = Math.min(Math.max(Number(input.count) || 4, 2), 8);
      const beats = ['全景交代环境', '人物出场', '人物动作特写', '情绪高潮', '收尾远景', '余韵', '转场', '结尾'];
      return {
        shots: Array.from({ length: count }, (_, i) => ({
          description: `${idea}，${beats[i % beats.length]}，电影感光影`,
          motion: ['镜头缓慢推进', '人物缓缓走入画面', '人物抬头看向远方', '镜头环绕人物', '镜头缓缓升起拉远', '画面渐暗', '镜头横移', '定格'][i % 8],
          duration: 5,
        })),
      };
    }
    case 'shots': {
      const dialogueCount = Array.isArray(input.dialogue) ? input.dialogue.length : 0;
      const names = Array.isArray(input.characterNames) ? (input.characterNames as string[]) : [];
      const location = str(input.location, '废墟街道');
      const count = 6;
      const descriptions = [
        `${location}全貌，残破的建筑剪影，薄雾弥漫，光线从云层缝隙洒下`,
        '主角从画面左侧走入，脚步踩过碎玻璃，镜头跟随',
        '主角停下，侧耳倾听，表情由疑惑转为专注',
        '收音机特写，指示灯忽明忽暗，指针轻微颤动',
        '同伴走到主角身后，两人对视，背景虚化',
        '两人背影走向远方的钟塔，镜头缓缓拉远升起',
      ];
      return {
        shots: Array.from({ length: count }, (_, index) => ({
          shotSize: pick(SHOT_SIZES, [0, 1, 3, 4, 2, 0][index]),
          cameraMove: pick(MOVES, [7, 5, 1, 0, 3, 2][index]),
          description: descriptions[index],
          duration: [5, 4, 3, 3, 4, 6][index],
          dialogueIndexes: dialogueCount ? [Math.min(index, dialogueCount - 1)] : [],
          characterNames: index === 0 || index === 3 ? [] : names.slice(0, index >= 4 ? 2 : 1),
        })),
      };
    }
    default:
      throw new Error(`未知的助手类型：${kind}`);
  }
}
