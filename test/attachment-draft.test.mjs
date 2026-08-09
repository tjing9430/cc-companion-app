// 反馈#12:附件草稿要跟文字草稿一样有「编辑/删除」。
// 渲染级单测——state 是顶层 const(既不是 window.state 也不是 ctx.state),
// 得在同一个 vm context 里求值才拿得到引用,拿到后照常改字段再调渲染函数。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8');

const noop = () => {};
const elStub = () => new Proxy({}, { get: (t, k) => (k === 'style' || k === 'classList' ? elStub() : noop), set: () => true });
const ctx = vm.createContext({
  console,
  window: { addEventListener: noop, location: { href: '', search: '' }, matchMedia: () => ({ matches: false, addEventListener: noop }) },
  document: new Proxy({}, {
    get: (t, k) => {
      if (k === 'querySelectorAll') return () => [];
      if (k === 'querySelector' || k === 'getElementById' || k === 'createElement') return () => elStub();
      if (k === 'body' || k === 'documentElement') return elStub();
      return noop;
    },
  }),
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  navigator: { userAgent: 'node' },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  EventSource: function () { return elStub(); },
  requestAnimationFrame: noop,
});
try { vm.runInContext(src, ctx, { filename: 'app.js' }); } catch (e) {}

// 顶层 const/let 进的是 context 的全局词法环境,不是 context 属性 → 得在同一 context 里求值才拿得到
const render = vm.runInContext('typeof renderAttachmentDraft === "function" ? renderAttachmentDraft : null', ctx);
const S = vm.runInContext('typeof state !== "undefined" ? state : null', ctx);
if (typeof render !== 'function') { console.error('FATAL: renderAttachmentDraft 没拿到'); process.exit(1); }
if (!S) { console.error('FATAL: state 没拿到'); process.exit(1); }

S.settings = S.settings || { userName: '我' };
S.uploading = S.uploading || {};

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { const r = fn(); if (r === true) { pass++; console.log(`✓ ${name}`); } else { fail++; console.log(`✗ ${name} — ${r}`); } }
  catch (e) { fail++; console.log(`✗ ${name} — 抛错 ${e.message}`); }
};

const files = [{ name: 'note.pdf', url: '/uploads/a.pdf', type: 'application/pdf' }];
const two = [files[0], { name: 'b.png', url: '/uploads/b.png', type: 'image/png' }];

t('默认:单文件有「编辑」也有「删除」(修好前只有删除)', () => {
  S.renamingFile = null;
  const h = render('chat', files);
  if (!h.includes('data-action="edit-pending-file-name"')) return '缺编辑按钮';
  if (!h.includes('data-action="remove-pending-file"')) return '缺删除按钮';
  return true;
});

t('多文件:每个都有自己的编辑/删除且带序号', () => {
  S.renamingFile = null;
  const h = render('chat', two);
  const edits = (h.match(/data-action="edit-pending-file-name"/g) || []).length;
  const dels = (h.match(/data-action="remove-pending-file"/g) || []).length;
  if (edits !== 2 || dels !== 2) return `应各 2 个,得 编辑${edits}/删除${dels}`;
  if (!h.includes('编辑 1') || !h.includes('编辑 2')) return '缺序号';
  return true;
});

t('改名态:换成输入框+保存+取消,且带原名', () => {
  S.renamingFile = { scope: 'chat', index: 0 };
  const h = render('chat', files);
  if (!h.includes('data-rename-input')) return '缺输入框';
  if (!h.includes('value="note.pdf"')) return '输入框没带原名';
  if (!h.includes('data-action="save-pending-file-name"')) return '缺保存';
  if (!h.includes('data-action="cancel-pending-file-name"')) return '缺取消';
  return true;
});

t('改名态只作用于那一个文件,另一个仍是编辑/删除', () => {
  S.renamingFile = { scope: 'chat', index: 0 };
  const h = render('chat', two);
  if ((h.match(/data-rename-input/g) || []).length !== 1) return '输入框不止一个';
  if ((h.match(/data-action="edit-pending-file-name"/g) || []).length !== 1) return '另一个文件的编辑按钮没了';
  return true;
});

t('scope 不匹配时不进改名态', () => {
  S.renamingFile = { scope: 'group', index: 0 };
  const h = render('chat', files);
  return !h.includes('data-rename-input') || 'scope 串了';
});

t('恶意文件名不能破属性(XSS)', () => {
  S.renamingFile = { scope: 'chat', index: 0 };
  const evil = [{ name: '"><img src=x onerror=alert(1)>', url: '/uploads/a.png', type: 'image/png' }];
  const h = render('chat', evil);
  if (h.includes('<img src=x onerror')) return '属性被击穿';
  if (!h.includes('&quot;') && !h.includes('&#39;')) return '没见转义痕迹';
  return true;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
