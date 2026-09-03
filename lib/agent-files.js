import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT_DIR, UPLOAD_DIR, MAX_JSON_BYTES } from './state.js';
import { cleanFileName, contentTypeFor, isPathInside } from './util.js';

const FILE_MARKER = /\[\[CCC_FILE:([^\]\r\n]+)\]\]/g;

function allowedAgentRoots() {
  const configured = String(process.env.DSH_CWD || '').trim();
  return Array.from(new Set([
    ROOT_DIR,
    path.resolve(ROOT_DIR, '..'),
    ...(configured ? [path.resolve(configured)] : []),
  ]));
}

function publishOne(filePath) {
  const resolved = path.resolve(String(filePath || '').trim().replace(/^['"]|['"]$/g, ''));
  if (!allowedAgentRoots().some((root) => isPathInside(root, resolved))) return null;
  let stat;
  try { stat = fs.statSync(resolved); } catch { return null; }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) return null;

  const displayName = cleanFileName(path.basename(resolved));
  const ext = path.extname(displayName).slice(0, 16);
  const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  const destination = path.join(UPLOAD_DIR, storedName);
  fs.copyFileSync(resolved, destination);
  return {
    url: `/uploads/${storedName}`,
    name: displayName,
    type: contentTypeFor(destination),
    size: stat.size,
  };
}

function collectAgentFiles(content) {
  const attachments = [];
  const seen = new Set();
  const cleaned = String(content || '').replace(FILE_MARKER, (_whole, rawPath) => {
    const key = String(rawPath || '').trim();
    if (!key || seen.has(key) || attachments.length >= 8) return '';
    seen.add(key);
    const attachment = publishOne(key);
    if (attachment) attachments.push(attachment);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { content: cleaned, attachments };
}

export { collectAgentFiles };
