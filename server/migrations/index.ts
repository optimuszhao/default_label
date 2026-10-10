// 迁移清单：按顺序追加，已经发布的迁移不要再改（改了会触发校验和告警）。
import type { Migration } from '../migrate.ts';
import { m0001 } from './0001_baseline.ts';
import { m0002 } from './0002_indexes.ts';
import { m0003 } from './0003_operators.ts';
import { m0004 } from './0004_catalog.ts';

export const MIGRATIONS: Migration[] = [m0001, m0002, m0003, m0004];
