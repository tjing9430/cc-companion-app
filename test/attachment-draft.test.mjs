// 反馈#12:附件草稿要跟文字草稿一样有「编辑/删除」。
//
// ★ 这份原来是「把整个 app.js 塞进 vm、靠函数提升取函数」那套,当时留了日落条款:
//   「等这些被测函数也拆成模块,这段就可以删掉、改成直接 import」。
//   renderAttachmentDraft 已经进 js/chat-view.js 了,所以现在就是那一天 —— 加载器退役。
import test from 'node:test';
import assert from 'node:assert/strict';

// state.js 在模块顶层读 localStorage(浏览器模块本该如此),Node 里得先垫一下
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
const { state: S } = await import('../public/js/state.js');
const { renderAttachmentDraft: render } = await import('../public/js/chat-view.js');

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
