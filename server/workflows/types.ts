// 工作流定义（附录 D）：织影产品层面的多步编排，不是 ComfyUI 节点图。
// 步骤之间用 TypeScript 函数取值，不用字符串表达式，没有注入风险。
import type { AssistKind, TaskType } from '../../shared/types.ts';

export interface WorkflowInput {
  key: string;
  label: string;
  type: 'text' | 'select' | 'image' | 'lines' | 'preset' | 'character';
  required?: boolean;
  default?: unknown;
  options?: (string | number)[];
  multiline?: boolean;
  min?: number;
  max?: number;
  placeholder?: string;
  hint?: string;
}

export interface StepState {
  status: 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'canceled';
  /** 这一步产出的素材 */
  assets: string[];
  taskIds: string[];
  /** forEach 串行时：已完成的项数 */
  cursor?: number;
  output?: unknown;
  error?: string;
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface RunContext {
  inputs: Record<string, unknown>;
  steps: Record<string, StepState>;
  userId: string;
}

/** 生成步骤里描述的任务；firstFrame 可以是素材 id，或"取某段视频的尾帧" */
export interface TaskSpec {
  type: TaskType;
  prompt: string;
  presets?: string[];
  negative?: string;
  params: { aspectRatio?: string; resolution?: string; duration?: number; seed?: number | null };
  inputs?: { firstFrame?: string | { lastFrameOf: string } | null; references?: string[] };
  title?: string;
}

export type WorkflowStep =
  | {
      id: string;
      kind: 'generate';
      label: string;
      /** 对每一项各生成一次：parallel 一起提交；sequential 上一项完成再提交下一项 */
      forEach?: { over: (c: RunContext) => unknown[]; mode: 'parallel' | 'sequential' };
      task: (c: RunContext, item: unknown, index: number, prev: StepState | null) => TaskSpec;
    }
  | { id: string; kind: 'select'; label: string; from: string; min: number; max: number; auto?: 'first'; hint?: string }
  | { id: string; kind: 'llm'; label: string; assist: AssistKind; input: (c: RunContext) => Record<string, unknown> }
  | { id: string; kind: 'local'; label: string; op: 'concat_videos' | 'set_character_ref'; source: (c: RunContext) => string[]; optional?: (c: RunContext) => boolean };

export interface WorkflowDef {
  id: string;
  title: string;
  description: string;
  /** 预计耗时说明 */
  estimate: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  /** 哪些步骤的产物算最终结果 */
  outputs: string[];
}

export const LIMITS = {
  activeRunsPerUser: 3,
  tasksPerRun: 60,
  forEachItems: 24,
};
