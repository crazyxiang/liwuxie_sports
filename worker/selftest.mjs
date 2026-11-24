/**
 * 本地自测：直接调用 Worker 的 fetch 处理函数，验证各接口能否跑通。
 * 用法：node worker/selftest.mjs
 * （Node 22 自带 fetch / crypto.subtle / atob；Cache API 不存在，会自动跳过缓存）
 */
import worker from './index.js';

const ctx = { waitUntil() {} };
const origin = 'https://liwuxie.example.com';

async function call(path) {
  const t0 = Date.now();
  const res = await worker.fetch(new Request(origin + path), {}, ctx);
  const body = await res.text();
  let summary = body.slice(0, 220).replace(/\s+/g, ' ');
  try {
    const j = JSON.parse(body);
    if (j.items) summary = `items=${j.items.length} ` + JSON.stringify(j.items[0] || {}).slice(0, 180);
    else if (j.tabs) summary = `tabs=${j.tabs.length} ` + JSON.stringify(j.tabs[0] || {}).slice(0, 180);
    else if (j.lines) summary = `lines=${j.lines.length} ` + JSON.stringify(j.lines.slice(0, 2));
    else if (j.error) summary = 'ERROR: ' + j.error + ' / ' + (j.detail || '');
  } catch {
    /* 非 JSON 就原样打印 */
  }
  const ms = Date.now() - t0;
  console.log(`[${res.status}] ${path}  (${ms}ms)\n    ${summary}\n`);
  return { status: res.status, body };
}

const today = new Date().toISOString().slice(0, 10);

await call('/api/lives');
await call('/api/rank?kind=team');
await call(`/api/schedule?date=${today}`);
await call('/api/replays?category=basketball&page=1');
await call('/api/repeats-unknown');
