/**
 * HTTP 接入层集成测试（2026-10-03 审查批次 C）。
 *
 * 存在的理由：此前 291 个用例全是引擎/房间/纯函数，接入层的缺陷（未捕获的流错误、
 * 永不响应的请求、把未知 /api 路径当成 SPA 回退返回 200 + index.html）全部逃过回归。
 *
 * 做法：把真实服务端拉到临时端口上跑（index.ts 是脚本、不导出可复用的 server 工厂），
 * 用 /api/health 轮询等它就绪；测试结束杀进程。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | null = null;

/** 带超时的 fetch：用于「请求永不响应」这类缺陷（否则整个用例会挂住） */
async function fetchWithTimeout(path: string, init: RequestInit = {}, ms = 3_000): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
}

beforeAll(async () => {
  // 直接以 node + tsx loader 启动：Windows 上 spawn('npx.cmd') 会 EINVAL，
  // 而用 shell:true 会多一层 cmd.exe（kill 只能杀掉 cmd、留下孤儿服务端占端口）。
  child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d: Buffer) => (log += String(d)));
  child.stderr?.on('data', (d: Buffer) => (log += String(d)));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetchWithTimeout('/api/health', {}, 1_000);
      if (r.ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`服务端未能在 30s 内就绪，输出：\n${log.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}, 40_000);

afterAll(() => {
  child?.kill('SIGKILL');
  child = null;
});

describe('批次 C · HTTP 接入层', () => {
  it('GET /api/version 返回 JSON', async () => {
    const r = await fetchWithTimeout('/api/version');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const j = (await r.json()) as { ok?: boolean; latest?: unknown };
    expect(j.ok).toBe(true);
  });

  it('HEAD /api/version 也应是该接口（不能落到 SPA 回退返回 HTML）', async () => {
    const r = await fetchWithTimeout('/api/version', { method: 'HEAD' });
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  it('未知 /api/* 必须 404 JSON，而不是 200 + index.html', async () => {
    const r = await fetchWithTimeout('/api/definitely-not-a-route');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toContain('application/json');
  });

  it('POST /api/feedback 收到 JSON null 也必须响应（不能一直挂着）', async () => {
    const r = await fetchWithTimeout('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(r.status).toBeLessThan(500);
  }, 10_000);

  it('缺失的 /assets/* 必须 404，而不是 200 + HTML（否则会被 nginx 贴上一年的 immutable 缓存）', async () => {
    const r = await fetchWithTimeout('/assets/index-nonexistent.js');
    expect(r.status).toBe(404);
  });

  it('SPA 入口仍然可用（别把回退整体改坏）', async () => {
    const r = await fetchWithTimeout('/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
  });

  it('deep link（/ABCD 这类前端路由）仍由 SPA 回退接管', async () => {
    const r = await fetchWithTimeout('/ABCD');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
  });

  it('纯前端发版（只换 dist、不重启服务）后 /api/version 立刻报出新构建标识', async () => {
    // 构建标识是**部署状态**而不是进程状态：若在启动时读一次就缓存，纯前端发版后客户端会把自己
    // 误判为旧包 —— 弹出「新版本已发布」而刷新无效（横幅永远消不掉，实测踩过）。
    // 这里直接改磁盘上的 client/dist/index.html 模拟该场景（finally 保证还原，且断言已还原）。
    const p = path.join(process.cwd(), '..', 'client', 'dist', 'index.html');
    const original = fs.readFileSync(p, 'utf8');
    try {
      await new Promise((r) => setTimeout(r, 10)); // 避开 mtime 的同毫秒粒度
      const fake = original.replace(/index-[A-Za-z0-9_-]+\.js/, 'index-FAKEBUILD.js');
      expect(fake).not.toBe(original); // 替换必须真的发生，否则用例形同虚设
      fs.writeFileSync(p, fake);
      const j = (await (await fetchWithTimeout('/api/version')).json()) as { build?: string };
      expect(j.build).toBe('index-FAKEBUILD.js');
    } finally {
      fs.writeFileSync(p, original);
    }
    expect(fs.readFileSync(p, 'utf8')).toBe(original); // 不得污染仓库
  });

  it('/api/* 有通用限流：单 IP 以远超 30 条/秒的速率打会被 429 挡下', async () => {
    // 此前只有注册/登录/反馈/管理登录各自限流，其余接口（含每次全量聚合的统计接口）完全不限。
    // 这里连打 45 次（> 30/s 窗口上限），必须出现 429；正常情况下偶尔 429 也不影响后续用例
    //（滑动窗口 1 秒自动回补），末尾等 1.1s 让窗口恢复。
    let got429 = 0;
    for (let i = 0; i < 45; i++) {
      const r = await fetchWithTimeout('/api/version', {}, 3_000).catch(() => null);
      if (r?.status === 429) got429 += 1;
    }
    expect(got429).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1_100));
  });

  it('/api/auth/me 仍正常返回（缓存路径的形状与直算一致）', async () => {
    const reg = await fetchWithTimeout('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `测试${Date.now() % 100000}`, password: 'pw123456' }),
    });
    expect(reg.status).toBe(200);
    const { token } = (await reg.json()) as { token: string };
    expect(typeof token).toBe('string');
    const auth = { Authorization: `Bearer ${token}` };
    const first = await fetchWithTimeout('/api/auth/me', { headers: auth });
    expect(first.status).toBe(200);
    const j1 = (await first.json()) as { ok?: boolean; account?: unknown; ladder?: unknown; stats?: unknown };
    expect(j1.ok).toBe(true);
    expect(j1.account).toBeTruthy();
    // 新账号还没有任何对局记录，stats 为 null 属既有行为：这里只断言字段存在（形状稳定）
    expect(j1).toHaveProperty('stats');
    expect(j1).toHaveProperty('ladder');
    // 第二次命中 60s 缓存：响应体必须与第一次完全一致
    const second = await fetchWithTimeout('/api/auth/me', { headers: auth });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(JSON.stringify(j1));
  });
});
