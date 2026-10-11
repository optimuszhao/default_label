// 所有后台作业类型在这里注册（应用启动时调用一次）
import { registerLibraryJobs } from '../library/derive.ts';

let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registered = true;
  registerLibraryJobs();
}
