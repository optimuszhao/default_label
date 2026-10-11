// 路由共用的小工具
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { getAssetRow } from '../repo.ts';

/** 错误响应统一带上请求编号，用户反馈问题时报编号，按编号搜日志 */
export function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message, requestId: reply.request.id });
}

export function parse<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply): z.infer<T> | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    void bad(reply, result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    return null;
  }
  return result.data;
}

export const uid = (request: FastifyRequest) => request.user!.id;

/** 素材属于这个用户且不在回收站（回收站里的素材不能再拿来生成） */
export function ownsAsset(userId: string, assetId: string | null | undefined): boolean {
  if (!assetId) return true;
  const row = getAssetRow(assetId);
  return Boolean(row && row.user_id === userId && row.deleted_at == null);
}
