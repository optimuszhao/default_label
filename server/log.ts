// 结构化日志（pino，一行一个 JSON，方便在 NAS 上 docker logs | grep）。
// 凭证类字段一律打码：cookie、authorization、password、secret、token、apiKey。
import pino from 'pino';
import { config } from './config.ts';

const SENSITIVE = ['cookie', 'authorization', 'password', 'secret', 'token', 'apiKey', 'api_key', 'appSecret'];

/** 打码路径：请求头，以及任意 3 层以内的同名字段 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  ...SENSITIVE.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
];

export function createLogger(destination?: pino.DestinationStream) {
  return pino(
    {
      level: config.logLevel,
      base: { app: 'weave', version: config.appVersion },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[已打码]' },
    },
    destination,
  );
}

export const logger = createLogger();
