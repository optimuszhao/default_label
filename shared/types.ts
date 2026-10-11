// 前后端共享的数据结构。前端通过相对路径引入，后端同样引入，保证接口字段一致。

export type TaskType = 't2i' | 'i2i' | 't2v' | 'i2v';
export type TaskStatus = 'queued' | 'paused' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type Capability = 'image' | 'video' | 'llm';
export type MediaKind = 'image' | 'video' | 'audio';

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  t2i: '文生图',
  i2i: '图生图',
  t2v: '文生视频',
  i2v: '图生视频',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  paused: '已暂停',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};

export function capabilityOf(type: TaskType): Capability {
  return type === 't2i' || type === 'i2i' ? 'image' : 'video';
}

export interface User {
  id: string;
  email: string;
  name: string;
  /** 超级管理员（ADMIN_EMAILS） */
  isAdmin: boolean;
  createdAt: number;
}

/** 后台算子列表的一行 */
export interface OperatorSummary {
  id: string;
  name: string;
  kind: 'comfyweb' | 'http' | 'mock';
  baseUrl: string;
  appid: string;
  enabled: boolean;
  maintenance: boolean;
  maintenanceNote: string | null;
  visibility: 'all' | 'admin_only';
  priority: number;
  maxInflight: number;
  settings: { imagePollMs: number; videoPollMs: number };
  running: number;
  status: 'unknown' | 'online' | 'offline' | 'maintenance' | 'disabled';
  health: { image: boolean; video: boolean; message: string | null; checkedAt: number | null };
  /** 密钥是否已设置（不返回内容） */
  secret: { set: boolean; updatedAt: number | null };
  tokenExpiresAt: number | null;
  tokenOk: boolean | null;
  createdAt: number;
  updatedAt: number;
}

/** 测试连接的一步：ok=null 表示跳过 */
export interface OperatorTestStep {
  key: string;
  label: string;
  ok: boolean | null;
  message: string;
  ms: number;
}

/** 站点公开配置（未登录也能读取） */
export interface SiteInfo {
  registration: 'open' | 'closed';
}

/** 算子 token 状态（只有管理员可见） */
export interface TokenStatus {
  /** 当前算子是否需要 token */
  supported: boolean;
  operator: string;
  base?: string;
  appid?: string;
  /** 是否配置了 appid / secret */
  configured?: boolean;
  hasToken?: boolean;
  /** token 的前几位，方便核对，不暴露完整内容 */
  tokenPreview?: string | null;
  issuedAt?: number | null;
  expiresAt?: number | null;
  /** 到期时间的依据：jwt = 从 token 里读出；assumed = 按文档的 72 小时推算；env = 手动配置的 token，未知 */
  expiresBasis?: 'jwt' | 'assumed' | 'manual' | 'env' | null;
  lastVerifyAt?: number | null;
  lastVerifyOk?: boolean | null;
  lastVerifyMessage?: string | null;
  lastLoginError?: string | null;
}

export interface UserSettings {
  /** 自动调度：开启后后台会按间隔自动尝试把排队任务提交给生成服务 */
  autoDispatch: boolean;
  /** 生成服务不可用时，重新尝试的间隔（秒） */
  pollIntervalSec: number;
}

export interface GenParams {
  aspectRatio: string; // '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9'
  resolution: string; // '720p' | '1080p' ...
  width: number;
  height: number;
  count: number;
  seed: number | null;
  steps?: number;
  cfg?: number;
  /** 图生图重绘强度 0-1 */
  strength?: number;
  /** 视频时长（秒） */
  duration?: number;
  fps?: number;
  /** 视频镜头运动提示，例如 push in / pan left */
  cameraMotion?: string;
  model?: string;
}

export interface TaskInputs {
  /** 图生图参考图 / 图生视频首帧，均为资产 id */
  referenceAssetIds?: string[];
  firstFrameAssetId?: string | null;
  lastFrameAssetId?: string | null;
}

export interface TaskLink {
  storyId?: string | null;
  shotId?: string | null;
  /** 在故事里的用途：分镜关键帧 / 分镜视频 */
  purpose?: 'keyframe' | 'video' | null;
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  title: string;
  prompt: string;
  negativePrompt: string;
  params: GenParams;
  inputs: TaskInputs;
  link: TaskLink;
  progress: number;
  attempts: number;
  maxAttempts: number;
  priority: number;
  lastError: string | null;
  /** 等待原因（服务不可用等），不算失败 */
  waitReason: string | null;
  /** 生成服务报告的当前阶段，例如「视频生成中」「超分中」 */
  stage: string | null;
  nextAttemptAt: number;
  manualKick: boolean;
  outputAssetIds: string[];
  /** 创作台 2.0 的配方（模板、变量、预设、用户原文），用于“改参数重跑” */
  recipe: import('./presets.ts').Recipe | null;
  /** 由故事批量或工作流创建时记录来源 */
  origin: { kind: 'batch' | 'workflow'; id: string; step?: string } | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Asset {
  id: string;
  kind: MediaKind;
  source: 'upload' | 'generated';
  mime: string;
  url: string;
  thumbUrl: string;
  width: number | null;
  height: number | null;
  prompt: string | null;
  taskId: string | null;
  storyId: string | null;
  shotId: string | null;
  purpose: 'keyframe' | 'video' | null;
  favorite: boolean;
  /** 视频时长（秒），从文件头读出 */
  duration: number | null;
  /** 生成配方：实际使用的种子和参数，用于复现 */
  gen: GenInfo | null;
  /** 派生来源（变体、以此为参考、图转视频、截帧） */
  parentAssetId: string | null;
  /** 和来源的关系：derive 派生；frame 截帧 */
  lineage: 'derive' | 'frame' | null;
  /** 视频封面（0.5 秒处一帧）；没有 ffmpeg 或不是视频时为空 */
  posterUrl: string | null;
  /** 字节数 */
  size: number | null;
  /** 0–5 星 */
  rating: number;
  /** pick 挑选 / reject 淘汰 */
  flag: 'pick' | 'reject' | null;
  note: string;
  folderId: string | null;
  tags: string[];
  /** 上传时的原文件名 */
  filename: string | null;
  /** 进入回收站的时间 */
  deletedAt: number | null;
  createdAt: number;
}

/** 资产库查询条件（列表、分面、批量操作、智能文件夹共用） */
export interface AssetQuery {
  q?: string;
  kind?: MediaKind | '';
  source?: Asset['source'] | '';
  folder?: string;
  tag?: string;
  storyId?: string;
  favorite?: boolean;
  minRating?: number;
  flag?: 'pick' | 'reject' | 'none' | '';
  /** 最近 N 天 */
  days?: number;
  /** 没放进任何文件夹 */
  unfiled?: boolean;
  trash?: boolean;
  sort?: 'new' | 'old' | 'rating' | 'size';
}

export interface AssetFolder {
  id: string;
  parentId: string | null;
  name: string;
  count: number;
}

export interface AssetTag {
  id: string;
  name: string;
  count: number;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: AssetQuery;
}

/** 素材被哪里用到（删除前提示） */
export interface AssetUsage {
  assetId: string;
  /** 被排队或生成中的任务引用：不能删除 */
  activeTasks: { id: string; title: string }[];
  /** 故事里的引用：镜头选定、角色参考图、设定 */
  stories: { storyId: string; title: string; where: string }[];
}

export interface StorageUsage {
  total: { count: number; bytes: number };
  byKind: { kind: string; count: number; bytes: number }[];
  byMonth: { month: string; count: number; bytes: number }[];
  byStory: { storyId: string | null; title: string; count: number; bytes: number }[];
  trash: { count: number; bytes: number };
  duplicates: { groups: number; wasted: number };
  disk: { free: number; total: number } | null;
}

/** 工作流运行（M8a） */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  title: string;
  /** running 进行中 / waiting 等你选择 / paused 已暂停 / succeeded / failed / canceled */
  status: 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'canceled';
  inputs: Record<string, unknown>;
  unattended: boolean;
  taskCount: number;
  error: string | null;
  steps: {
    id: string;
    kind: 'generate' | 'select' | 'llm' | 'local';
    label: string;
    status: 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'canceled';
    assets: string[];
    taskIds: string[];
    note: string | null;
    error: string | null;
    from?: string;
    min?: number;
    max?: number;
    hint?: string | null;
  }[];
  /** 最终产物 */
  outputs: string[];
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** 后台作业（缩略图、迁移、成片渲染……） */
export interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  progress: number;
  stage: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GenInfo {
  type: TaskType;
  /** 实际提交给算子的种子 */
  seed: number | null;
  width: number | null;
  height: number | null;
  duration?: number | null;
  steps?: number | null;
  negativePrompt?: string;
  operator: string;
  /** 用了哪个模板和哪些预设 */
  templateId?: string | null;
  presets?: string[];
}

export interface ProviderHealth {
  provider: string;
  image: boolean;
  video: boolean;
  llm: boolean;
  checkedAt: number;
  message?: string;
}

// ---------------- 故事工坊 ----------------

/** 设定上挂的参考图：primary 主参考图；front / side / full 三视图；expression 表情；outfit:<id> 服装 */
export interface ElementRef {
  assetId: string;
  role: string;
}

export interface Outfit {
  id: string;
  name: string;
  /** 会拼进提示词的服装描述 */
  snippet: string;
}

export interface Character {
  id: string;
  name: string;
  role: string; // 主角 / 配角 / 反派 ...
  appearance: string; // 外貌描述，会拼进分镜提示词保持一致性
  personality: string;
  referenceAssetId: string | null;
  /** 别名：描述里写别名也能识别成这个角色 */
  aliases?: string[];
  /** 固定种子：定妆照和镜头都用它，保证脸型一致 */
  seed?: number | null;
  /** 这个角色专用的反向提示词片段 */
  negative?: string;
  outfits?: Outfit[];
  /** 更多参考图（主参考图之外） */
  refs?: ElementRef[];
  /** 在系列的所有集里共享 */
  seriesShared?: boolean;
}

/** 角色之外的设定：地点、道具、画风 */
export interface StoryElement {
  id: string;
  kind: 'location' | 'prop' | 'style';
  name: string;
  /** 会拼进提示词的描述 */
  snippet: string;
  negative?: string;
  aliases?: string[];
  seed?: number | null;
  refs?: ElementRef[];
  /** 地点的时段 / 天气变体等 */
  variants?: { id: string; name: string; snippet: string }[];
  seriesShared?: boolean;
}

export interface DialogueLine {
  id: string;
  characterId: string | null; // null 表示旁白
  text: string;
  emotion: string;
  /** dialogue 台词（默认）/ narration 旁白 / caption 字幕卡 */
  kind?: 'dialogue' | 'narration' | 'caption';
  /** 配音素材（M8b） */
  voiceAssetId?: string | null;
}

export interface Shot {
  id: string;
  shotSize: string; // 远景 / 全景 / 中景 / 近景 / 特写
  cameraMove: string; // 固定 / 推 / 拉 / 摇 / 移 / 跟 / 环绕
  description: string; // 画面描述
  dialogueIds: string[];
  duration: number; // 秒
  characterIds: string[];
  keyframeAssetId: string | null; // 用户选定的关键帧（为空则用最新一张）
  videoAssetId: string | null;
  /** 镜头编号（例如 1-2-3），留空时按顺序自动编号 */
  code?: string;
  /** 出镜的地点、道具、画风设定（角色在 characterIds 里） */
  elementIds?: string[];
  /** 定稿：批量操作不会改动 */
  locked?: boolean;
  /** redo：标记为待返工 */
  review?: 'redo' | null;
  /** 锁定的种子 */
  seed?: number | null;
  /** 追加在自动提示词后面的内容 */
  extraPrompt?: string;
  negative?: string;
  /** 完全手写的提示词（填了就不再自动拼） */
  promptOverride?: string;
  /** 视频首帧来源：选定的关键帧（默认）/ 接续上一镜尾帧 / 指定素材 */
  firstFrame?: { mode: 'keyframe' | 'prev_last' | 'asset'; assetId?: string | null };
  /** 成片时的裁剪点（秒） */
  trimIn?: number;
  trimOut?: number;
  transition?: 'cut' | 'fade';
}

export interface Scene {
  id: string;
  title: string;
  location: string;
  /** 关联的地点设定（描述会拼进提示词） */
  locationId?: string | null;
  time: string;
  summary: string; // 剧本段落
  dialogue: DialogueLine[];
  shots: Shot[];
}

export interface Chapter {
  id: string;
  title: string;
  summary: string;
  /** 前情提要（AI 生成，给后面的章节当上下文） */
  recap?: string;
  scenes: Scene[];
}

export interface StoryData {
  logline: string; // 一句话故事
  genre: string;
  tone: string;
  visualStyle: string; // 统一画风，会拼进所有分镜提示词
  aspectRatio: string;
  outline: string; // 故事大纲（长文本）
  /** 关键帧的负向提示词（不填用默认值） */
  negativePrompt?: string;
  /** 目标成片时长（秒），进度看板用 */
  targetDuration?: number;
  /** 默认种子 */
  defaultSeed?: number | null;
  characters: Character[];
  /** 地点、道具、画风设定 */
  elements?: StoryElement[];
  chapters: Chapter[];
}

export interface StorySummary {
  id: string;
  title: string;
  /** 版本号，每次保存 +1 */
  rev: number;
  logline: string;
  coverUrl: string | null;
  shotCount: number;
  updatedAt: number;
  createdAt: number;
}

export interface Story extends StorySummary {
  data: StoryData;
  /** 各个元素的排序键（id → 键），增量保存时计算新位置用 */
  keys?: Record<string, string>;
  /** 迁移失败的旧故事：只读打开 */
  readOnly?: boolean;
}

export interface StorySnapshot {
  id: string;
  rev: number;
  title: string;
  /** auto 自动 / daily 每日 / manual 手动 / ai:<kind> AI 改写前 / before_batch 批量生成前 / before_restore 恢复前 / migration 升级前的原始内容 */
  reason: string;
  label: string | null;
  /** 永久保留（手动保存、升级前的原始内容） */
  pinned: boolean;
  stats: { chapters: number; scenes: number; shots: number; characters: number } | null;
  createdAt: number;
}

export type AssistKind =
  | 'polish' // 润色提示词
  | 'outline' // 生成故事大纲
  | 'characters' // 生成角色
  | 'chapters' // 拆分章节与场次
  | 'dialogue' // 为场次写台词
  | 'shots' // 为场次设计分镜
  | 'expand' // 扩写提示词
  | 'translate' // 中英互译（保留 {变量}）
  | 'variants' // 4 条变体，每条只改一个维度
  | 'fill' // 一句想法填出模板全部变量
  | 'motion' // 图转视频的动作建议（轻微 / 中等 / 戏剧性）
  | 'inspire' // 随机灵感
  | 'recap' // 章节前情提要
  | 'extract' // 从剧本里提取角色、地点、道具
  | 'split' // 把原著长文拆成章节
  | 'split_shots'; // 一句话拆成几个镜头（工作流用）

export const ASSIST_KINDS: AssistKind[] = ['polish', 'outline', 'characters', 'chapters', 'dialogue', 'shots', 'expand', 'translate', 'variants', 'fill', 'motion', 'inspire', 'recap', 'extract', 'split', 'split_shots'];

export type ServerEvent =
  | { type: 'task'; task: Task }
  | { type: 'task-removed'; id: string }
  | { type: 'health'; health: ProviderHealth }
  | { type: 'asset'; asset: Asset }
  /** 进入回收站（at 为时间）或从回收站恢复（at 为 null） */
  | { type: 'assets-trashed'; ids: string[]; at: number | null }
  /** 彻底删除 */
  | { type: 'assets-removed'; ids: string[] }
  | { type: 'job'; job: Job }
  | { type: 'workflow-run'; run: WorkflowRun }
  /** 故事被修改（clientId 是发起修改的那个编辑器，用来忽略自己的回声） */
  | { type: 'story-rev'; storyId: string; rev: number; clientId: string | null };
