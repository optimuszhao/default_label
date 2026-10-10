// 前后端共享的数据结构。前端通过相对路径引入，后端同样引入，保证接口字段一致。

export type TaskType = 't2i' | 'i2i' | 't2v' | 'i2v';
export type TaskStatus = 'queued' | 'paused' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type Capability = 'image' | 'video' | 'llm';
export type MediaKind = 'image' | 'video';

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
  expiresBasis?: 'jwt' | 'assumed' | 'env' | null;
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
  createdAt: number;
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

export interface Character {
  id: string;
  name: string;
  role: string; // 主角 / 配角 / 反派 ...
  appearance: string; // 外貌描述，会拼进分镜提示词保持一致性
  personality: string;
  referenceAssetId: string | null;
}

export interface DialogueLine {
  id: string;
  characterId: string | null; // null 表示旁白
  text: string;
  emotion: string;
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
}

export interface Scene {
  id: string;
  title: string;
  location: string;
  time: string;
  summary: string; // 剧本段落
  dialogue: DialogueLine[];
  shots: Shot[];
}

export interface Chapter {
  id: string;
  title: string;
  summary: string;
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
  characters: Character[];
  chapters: Chapter[];
}

export interface StorySummary {
  id: string;
  title: string;
  /** 版本号，保存时带上用于冲突检测 */
  rev: number;
  logline: string;
  coverUrl: string | null;
  shotCount: number;
  updatedAt: number;
  createdAt: number;
}

export interface Story extends StorySummary {
  data: StoryData;
}

export interface StorySnapshot {
  id: string;
  rev: number;
  title: string;
  /** daily：每日自动；ai:<kind>：AI 改写前；restore：恢复前 */
  reason: string;
  createdAt: number;
}

export type AssistKind =
  | 'polish' // 润色提示词
  | 'outline' // 生成故事大纲
  | 'characters' // 生成角色
  | 'chapters' // 拆分章节与场次
  | 'dialogue' // 为场次写台词
  | 'shots'; // 为场次设计分镜

export type ServerEvent =
  | { type: 'task'; task: Task }
  | { type: 'task-removed'; id: string }
  | { type: 'health'; health: ProviderHealth }
  | { type: 'asset'; asset: Asset };
