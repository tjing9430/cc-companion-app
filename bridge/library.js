/**
 * Mirror the app's 资料库 (documents) into the agent's working directory.
 *
 * Retrieval alone (top-N chunks per turn, scored against what you just said) doesn't match
 * what people expect when they upload a file: "it's in the library now, so it can look at it."
 * With a Claude Code CLI behind the bridge the agent has real file tools — so the honest fix
 * is to put the documents where it can actually open them.
 *
 * Retrieval still runs; it surfaces the relevant bit without the agent going looking. This is
 * the other half: the whole file, on demand, when 3 chunks aren't enough.
 *
 * Only ever touches files inside <cwd>/<LIBRARY_DIR>/ — that directory is considered ours and
 * is kept in sync with the library (files for deleted documents are removed). Don't put your
 * own files there.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LIBRARY_DIR = '资料库';

// Filenames come from user-supplied document names: strip anything that could escape the
// directory or confuse a shell, and keep it short enough for every filesystem.
export function safeFileName(name) {
  let out = String(name == null ? '' : name)
    .replace(/[\x00-\x1f\x7f]/g, '')          // control chars
    .replace(/[/\\]/g, '-')                   // path separators → can no longer traverse
    .replace(/-{2,}/g, '-')                   // ..-..- collapses instead of turning into noise
    .replace(/^[.\-]+/, '')                   // no leading dot ('..', hidden) or dash
    .replace(/[<>:"|?*`$]/g, '')              // shell + Windows-hostile
    .trim();
  if (!out) out = 'untitled';
  if (out.length > 80) {
    const ext = path.extname(out).slice(0, 12);
    out = out.slice(0, 80 - ext.length) + ext;
  }
  return out;
}

/**
 * Decide what to write and what to remove. Pure — no IO — so the interesting part is testable.
 * `docs`: [{id, name, size, updated_at}]  `existing`: filenames currently in the directory.
 */
export function planSync(docs, existing) {
  const list = Array.isArray(docs) ? docs : [];
  const bases = new Map();
  for (const doc of list) {
    const base = safeFileName(doc && doc.name);
    bases.set(base, (bases.get(base) || 0) + 1);
  }
  const files = new Map();   // filename -> doc
  for (const doc of list) {
    const base = safeFileName(doc && doc.name);
    // Two documents can share a name; only then pay the ugliness of an id suffix.
    let file = base;
    if (bases.get(base) > 1) {
      const ext = path.extname(base);
      file = `${base.slice(0, base.length - ext.length)}-${doc.id}${ext}`;
    }
    files.set(file, doc);
  }
  const keep = new Set(files.keys());
  const deletes = (Array.isArray(existing) ? existing : []).filter((f) => !keep.has(f));
  return { files, deletes };
}

// A one-line note for the prompt so the agent knows the directory exists at all —
// it can't read what it doesn't know to look for.
export function manifestLine(files) {
  const names = [...files.keys()];
  if (!names.length) return '';
  return `资料库（${names.length} 份，就在你工作目录的 ${LIBRARY_DIR}/ 下，可以直接读）：\n`
    + names.map((n) => `- ${LIBRARY_DIR}/${n}`).join('\n');
}

export async function syncLibrary({ appUrl, token, cwd, fetchImpl = fetch, log = () => {} }) {
  const dir = path.join(cwd, LIBRARY_DIR);
  const headers = token ? { 'x-app-token': token } : {};
  let docs;
  try {
    const res = await fetchImpl(`${appUrl}/api/documents`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    docs = await res.json();
  } catch (err) {
    log('warn', `library sync skipped: ${err.message}`);
    return '';   // never block a turn because the mirror failed
  }
  if (!Array.isArray(docs)) return '';

  let existing = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    existing = fs.readdirSync(dir);
  } catch (err) {
    log('warn', `library dir unusable: ${err.message}`);
    return '';
  }

  const { files, deletes } = planSync(docs, existing);

  for (const file of deletes) {
    try { fs.rmSync(path.join(dir, file), { force: true }); } catch { /* ignore */ }
  }

  for (const [file, doc] of files) {
    const target = path.join(dir, file);
    // Belt and braces: even after sanitising, refuse anything that resolved outside the dir.
    if (path.dirname(path.resolve(target)) !== path.resolve(dir)) {
      log('warn', `library: refusing suspicious path for document ${doc.id}`);
      files.delete(file);
      continue;
    }
    // Only re-download when the document actually changed. NOT by size: doc.size counts
    // characters while the file counts bytes, so anything non-ASCII never matches and the
    // whole library gets rewritten every single turn. Stamp the file with the document's
    // updated_at instead and compare that — exact, and needs no sidecar index.
    const stamp = Date.parse(doc.updated_at || '') || 0;
    try {
      const stat = fs.statSync(target);
      if (stamp && Math.floor(stat.mtimeMs) === stamp) continue;
    } catch { /* not written yet */ }
    try {
      const res = await fetchImpl(`${appUrl}/api/documents/${doc.id}`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const full = await res.json();
      fs.writeFileSync(target, String((full && full.content) || ''), 'utf8');
      if (stamp) fs.utimesSync(target, new Date(stamp), new Date(stamp));
    } catch (err) {
      log('warn', `library: could not write ${file}: ${err.message}`);
      files.delete(file);
    }
  }

  return manifestLine(files);
}
