import { Logger } from '@nestjs/common';
import { newId } from '../common/util';
import { withLogContext } from './log-context';
import { metrics } from './metrics';

interface Req {
  method: string; originalUrl?: string; url: string; baseUrl?: string;
  route?: { path?: string }; headers: Record<string, string | string[] | undefined>; principal?: { id: string };
}
interface Res { statusCode: number; setHeader(n: string, v: string): void; on(ev: 'finish' | 'close', fn: () => void): void }

const log = new Logger('HTTP');
const TASK_PATH = /^\/tasks\/([0-9a-f-]{36})/i;

/**
 * Express middleware: request id (X-Request-Id in and out), taskId from /tasks/:id, one JSON
 * access log line and jpo_http_requests_total per request. Logs the path without the query
 * string, so an ?api_key= never reaches the logs.
 */
export function httpLogging(req: Req, res: Res, next: () => void) {
  const incoming = req.headers['x-request-id'];
  const requestId = typeof incoming === 'string' && /^[\w.-]{1,64}$/.test(incoming) ? incoming : newId();
  res.setHeader('X-Request-Id', requestId);
  const path = (req.originalUrl ?? req.url).split('?')[0];
  const taskId = path.match(TASK_PATH)?.[1];
  const started = process.hrtime.bigint();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : 'unmatched';
    metrics.inc('jpo_http_requests_total', { method: req.method, route, status: String(res.statusCode) });
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    withLogContext({ requestId, ...(taskId ? { taskId } : {}), ...(req.principal ? { principal: req.principal.id } : {}) }, () =>
      log.log({ msg: `${req.method} ${path} ${res.statusCode}`, method: req.method, path, status: res.statusCode, ms }));
  };
  res.on('finish', finish);
  res.on('close', finish);
  withLogContext({ requestId, ...(taskId ? { taskId } : {}) }, next);
}
