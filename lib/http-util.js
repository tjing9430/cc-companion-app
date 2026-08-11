// HTTP 边界工具:错误类型、JSON 读写、公共响应头、鉴权、路由归一。
import { AUTH_TOKEN, MAX_JSON_BYTES } from './state.js';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function endNoContent(res) {
  res.writeHead(204);
  res.end();
}

function setCommonHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-app-token');
  res.setHeader('x-content-type-options', 'nosniff');
}

function isAuthorized(req, url = null) {
  if (!AUTH_TOKEN) return true;
  const token = String(req.headers['x-app-token'] || '').trim();
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token === AUTH_TOKEN || auth === AUTH_TOKEN) return true;
  // Query-string token only authorizes GET (EventSource can't set headers). Never for writes:
  // SSE/asset URLs leak into history, proxy logs, Referer — a leaked token must not enable DELETE.
  if (req.method === 'GET') {
    const query = url && url.searchParams ? String(url.searchParams.get('token') || '').trim() : '';
    if (query && query === AUTH_TOKEN) return true;
  }
  return false;
}

function normalizeRoute(route) {
  const value = String(route || '/').replace(/\/{2,}/g, '/');
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

class HttpError extends Error {
  constructor(statusCode, errorCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

export {
  HttpError, readJson, sendJson, endNoContent, setCommonHeaders, isAuthorized, normalizeRoute,
};
