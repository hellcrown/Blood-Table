import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  accountLadder,
  initAuthRevocations,
  initAuthStore,
  ladderBoard,
  login as authLogin,
  pruneRevocations,
  register as authRegister,
  revokeToken,
  cleanAccountName,
  isNameRegistered,
  verifyToken,
} from './auth';
import { clearFeedback, initFeedbackStore, listFeedback, submitFeedback } from './feedback';
import { clearMatches, initMatchStore, listMatches, matchCharLeaderboard, matchPlayerStats, matchStats } from './matchlog';
import { IpTable, SlidingWindow } from './net/limits';
import { attachHeartbeat, startHeartbeat, type HeartSocket } from './net/heartbeat';
import { dauSummary, flushDau, initDauStore, recordConnection } from './dau';
import { findAudit, initAuditStore, loadAuditGame } from './audit';
import { ChatHub } from './chat';
import { RoomManager } from './rooms';
import { CHANGELOG, LATEST } from '@shared/changelog';

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIST = path.resolve(process.cwd(), '../client/dist');
/**
 * 当前部署的前端构建标识 = 构建产物里的哈希资源文件名。
 * 页面用 import.meta.url 拿到自己的构建标识，两者不等即说明页面是旧包 —— 比"更新日志日期"
 * 精确得多（同一日内多次发版也认得出，而最近 30 个提交里 21 个根本没动更新日志）。
 * 读不到（未构建 / 老部署）时为 null，客户端自动回退到日期口径。
 *
 * **必须按磁盘现状读，不能在启动时读一次就缓存**：构建标识是**部署状态**而不是进程状态。
 * 纯前端发版（只换 client/dist、不重启服务）时若仍报旧标识，客户端会把自己判成旧包，
 * 弹出"新版本已发布"而刷新无效（永远消不掉）。按 mtime 缓存以省去每次请求的读盘。
 */
let buildIdCache: { mtimeMs: number; id: string | null } | null = null;
function currentBuildId(): string | null {
  try {
    const p = path.join(CLIENT_DIST, 'index.html');
    const mtimeMs = fs.statSync(p).mtimeMs;
    if (!buildIdCache || buildIdCache.mtimeMs !== mtimeMs) {
      const html = fs.readFileSync(p, 'utf8');
      buildIdCache = { mtimeMs, id: /assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] ?? null };
    }
    return buildIdCache.id;
  } catch {
    return null;
  }
}
/** 管理员密钥（环境变量 ADMIN_KEY；未设置时管理员功能停用） */
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
/** 管理员会话 token → 过期时间（24h） */
const adminTokens = new Map<string, number>();
/** 管理登录失败限速：IP → 失败次数与锁定截止时间 */
const loginFails = new Map<string, { count: number; until: number; last: number }>();

function loginBlocked(req: http.IncomingMessage): number {
  const ip = clientIp(req);
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.until > 0 && Date.now() >= rec.until) {
    loginFails.delete(ip);
    return 0;
  }
  return rec.until > 0 ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
}

function recordLoginFail(req: http.IncomingMessage): void {
  const ip = clientIp(req);
  const rec = loginFails.get(ip) ?? { count: 0, until: 0, last: 0 };
  rec.count += 1;
  rec.last = Date.now();
  if (rec.count >= 5) {
    rec.until = Date.now() + 60_000;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
}

function issueAdminToken(): string {
  const now = Date.now();
  for (const [t, exp] of adminTokens) if (exp < now) adminTokens.delete(t);
  const token = randomBytes(24).toString('hex');
  adminTokens.set(token, now + 24 * 3600_000);
  return token;
}

/** 恒时比较：哈希后定长对比，避免逐字符比较的时序侧信道泄漏密钥/密码 */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function isAdmin(req: http.IncomingMessage): boolean {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '');
  const token = m?.[1] ?? '';
  const exp = adminTokens.get(token);
  if (exp == null || exp < Date.now()) return false;
  return true;
}

function isLoopback(req: http.IncomingMessage): boolean {
  // 经反向代理（Caddy/Nginx 会注入 X-Forwarded-*）转发的请求视为外部来源，
  // 防止外网用户通过本机代理绕过 loopback 限制
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto']) return false;
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * 客户端真实 IP（限流/登录锁定/反馈归因用）。
 * 经本机回环反向代理转发时取 X-Forwarded-For 的最后一跳——那是可信代理追加的真实来源，
 * 取首跳会被伪造头欺骗；直连（含局域网/Tailscale）直接用 socket 地址。
 */
function clientIp(req: http.IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? '';
  const viaLoopbackProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  if (viaLoopbackProxy && typeof xff === 'string' && xff.trim() !== '') {
    const hops = xff.split(',').map((h) => h.trim()).filter((h) => h !== '');
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return remote;
}

/** 读取 POST 请求的 JSON body（超过 64KB 直接断开连接，拒绝继续接收；15s 无进展也断开） */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    // 悬挂请求兜底：只声明 Content-Length 却不发体，会把连接一直吊着（占一条上游连接）。
    // 正常提交远快于 15s，故这里主动断开。
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('body timeout'));
    }, 15_000);
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    // setEncoding 让 Node 用 StringDecoder 处理 chunk 边界：多字节字符（反馈正文以中文为主，
    // 3 字节/字）被 TCP 劈在两个 chunk 之间时不会解码成 U+FFFD 乱码
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      // 上限按字节数计：字符串 length 是 UTF-16 码元数，全 CJK 内容下实际字节可达其 3 倍
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) {
        req.destroy();
        settle(() => reject(new Error('body too large')));
      }
    });
    req.on('end', () => settle(() => resolve(data)));
    req.on('error', (e) => settle(() => reject(e)));
  });
}

/** Tailscale 虚拟内网网段：100.64.0.0/10（100.64.x.x ~ 100.127.x.x） */
function isTailscaleIp(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip);
  return m != null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** 私有网段（含 IPv6 本机/ULA）：公网访客不应拿到服务器的内网地址清单 */
function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('::ffff:')) return isPrivateIp(ip.slice(7)); // IPv4-mapped
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (/^127\./.test(ip)) return true;
  if (isTailscaleIp(ip)) return true;
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

/** 本机地址：Tailscale 虚拟内网 + 常规局域网 IPv4（可能有多块网卡/虚拟网卡，全部列出） */
const { tailscaleIps, lanIps } = (() => {
  const tailscale: string[] = [];
  const lan: string[] = [];
  const nets = os.networkInterfaces();
  for (const infos of Object.values(nets)) {
    for (const ni of infos ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        (isTailscaleIp(ni.address) ? tailscale : lan).push(ni.address);
      }
    }
  }
  return { tailscaleIps: tailscale, lanIps: lan };
})();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  // 构建产物里真实存在的类型：黑市牌动画用 gif，另有 robots/sitemap
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const root = CLIENT_DIST;
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath0 = path.normalize(path.join(root, rel));
  // 必须仍在静态根目录内（带分隔符边界，防同名前缀目录）；URL 构造器已归一化 ..，此处双保险
  if (!filePath0.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  let filePath = filePath0;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // 带内容哈希的静态资源不做 SPA 回退：缺失就是缺失。
    // 否则 /assets/<已删除的旧哈希>.js 会返回 200 + index.html，而 nginx 给 /assets/ 加了
    // 「一年 immutable」——旧页面会把 HTML 当 JS 执行（MIME 报错白屏），错误响应还会被缓存一年。
    if (rel.startsWith('/assets/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    // SPA 回退（前端路由 / 深链）
    filePath = path.join(root, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  // 读流必须接住 error：existsSync 与 createReadStream 之间有竞态（部署时 dist 被清空、
  // 或 fd 耗尽），未监听的 'error' 是**未捕获异常** —— 会直接结束进程、全场玩家掉线。
  const stream = fs.createReadStream(filePath);
  stream.on('error', (e) => {
    console.error('[static] 读取失败:', filePath, e);
    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } else {
      res.destroy(); // 已发头：中断连接，别让客户端收到一个被截断的 200
    }
  });
  stream.pipe(res);
}

/** 公开角色胜率榜缓存（60s）：防刷同时省去每次全量聚合 */
let publicStatsCache: { at: number; body: string } | null = null;
/** 天梯榜缓存（60s）：同为公开接口，每次请求都要全量 map+sort */
let ladderCache: { at: number; body: string } | null = null;

/* ---------------- 玩家账号接口限流 ---------------- */
/** 注册频率：单 IP 10 次/小时（防脚本刷号） */
const regLimit = new IpTable(
  () => new SlidingWindow(3600_000, 10),
  (w, now) => w.idle(now),
);
/** 登录尝试频率：单 IP 20 次/10 分钟 */
const authTryLimit = new IpTable(
  () => new SlidingWindow(600_000, 20),
  (w, now) => w.idle(now),
);
/** 登录失败锁定：连续 5 次失败锁 60s（与 admin 登录同口径） */
const authFails = new Map<string, { count: number; until: number; last: number }>();

function authBlocked(ip: string): number {
  const rec = authFails.get(ip);
  if (!rec) return 0;
  if (rec.until > 0 && Date.now() >= rec.until) {
    authFails.delete(ip);
    return 0;
  }
  return rec.until > 0 ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
}

function recordAuthFail(ip: string): void {
  const rec = authFails.get(ip) ?? { count: 0, until: 0, last: 0 };
  rec.count += 1;
  rec.last = Date.now();
  if (rec.count >= 5) {
    rec.until = Date.now() + 60_000;
    rec.count = 0;
  }
  authFails.set(ip, rec);
}

/** 从 Authorization 头解析 Bearer 令牌并校验账号身份 */
function authAccount(req: http.IncomingMessage) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '');
  return m ? verifyToken(m[1]) : null;
}

const manager = new RoomManager();
// 管理员会话令牌交给房间层：管理端加入/观战任意房间免密码（令牌 24h 过期，adminTokens 表为准）
manager.setAdminTokenValidator((t) => {
  const exp = adminTokens.get(t);
  return exp != null && exp > Date.now();
});

/**
 * 通用 API 限流：/api/* 每 IP 30 条/秒。
 * 此前只有注册/登录/反馈/管理登录各有自己的限流，**其余接口完全没有**：
 * 单个连接就能以任意速率打它们，而其中有每次都要全量聚合的统计接口
 * （role 胜率榜 / 天梯榜 / 个人战绩），它们与 500ms 的对局 tick 共用唯一事件循环。
 * 30/s 对正常客户端极其宽松（页面只在用户操作时请求，版本提示每 5 分钟一次），
 * 但对脚本刷接口是硬上限。静态资源不限流：页面加载本就会并发拉若干资源。
 */
const apiLimit = new IpTable(
  () => new SlidingWindow(1000, 30),
  (w, now) => w.idle(now),
);

/**
 * /api/auth/me 的每账号 60s 缓存：matchPlayerStats 每次都要扫最多 2 万条对局做聚合，
 * 而一个令牌就能反复打（把一次登录放大成任意次全量扫描）。个人战绩不需要秒级实时。
 */
const meCache = new Map<string, { at: number; body: string }>();

const server = http.createServer((req, res) => {
  // 基础安全头（对全部响应生效，含静态与 API）。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // CSP：构建产物全部为外链 self 资源、无内联脚本；style 因框架运行时写样式保留 unsafe-inline。
  // connect-src 只留 'self'：现代浏览器下同源 WS/WSS 升级已被覆盖，显式放行 ws:/wss: scheme
  // 等于允许 XSS 后向任意外部 WebSocket 主机外传数据
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
  const url = new URL(req.url ?? '/', 'http://localhost');
  // 通用 API 限流（静态资源不限）：超限直接 429，别让刷接口的流量挤占对局 tick
  if (url.pathname.startsWith('/api/') && !apiLimit.get(clientIp(req)).allow()) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, msg: '请求过于频繁，请稍后再试' }));
    return;
  }
  if (url.pathname === '/api/stats/chars' && req.method === 'GET') {
    if (publicStatsCache && Date.now() - publicStatsCache.at < 60_000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(publicStatsCache.body);
      return;
    }
    const body = JSON.stringify({ ok: true, total: matchStats().total, chars: matchCharLeaderboard(5) });
    publicStatsCache = { at: Date.now(), body };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  // 版本提示：把「服务器上跑的是哪一条更新日志」告诉在线页面，
  // 页面据此判断自己是不是旧包（浏览器缓存里的旧 JS）并提示刷新。no-store 防中间层缓存旧版本号。
  if (url.pathname === '/api/version' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        ok: true,
        latest: LATEST ? { date: LATEST.date, title: LATEST.title } : null,
        build: currentBuildId(),
        total: CHANGELOG.length,
      }),
    );
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: manager.roomCount(), games: manager.countActiveGames(), draining: manager.isDraining() }));
    return;
  }
  if (url.pathname === '/api/stats/ladder' && req.method === 'GET') {
    // 与 /api/stats/chars 同款 60s 缓存：天梯榜每次请求都要把全部注册账号 map+sort，
    // 而这是**匿名可打**的公开接口 —— 几十个并发就足以占满唯一事件循环、拖慢 500ms 对局 tick
    if (ladderCache && Date.now() - ladderCache.at < 60_000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(ladderCache.body);
      return;
    }
    const body = JSON.stringify({
      ok: true,
      board: ladderBoard().slice(0, 50).map(({ accountId, ...row }) => row),
    });
    ladderCache = { at: Date.now(), body };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    void readBody(req).then((body) => {
      const send = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      const ip = clientIp(req);
      if (!regLimit.get(ip).allow()) {
        send(429, { ok: false, msg: '注册过于频繁，请 1 小时后再试' });
        return;
      }
      let parsed: { name?: unknown; password?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        /* 忽略解析失败，按空内容处理 */
      }
      if (parsed == null || typeof parsed !== 'object') parsed = {}; // 字面量 null/原始值：归一化防解引用异常挂起连接
      const r = authRegister(parsed.name, parsed.password);
      if (!r.ok) {
        send(r.code === 'NAME_TAKEN' ? 409 : 400, { ok: false, msg: r.msg });
        return;
      }
      send(200, { ok: true, token: r.token, account: r.account });
    })
      .catch(() => {
        /* body 超限已断开连接 */
      });
    return;
  }
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    void readBody(req).then((body) => {
      const send = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      const ip = clientIp(req);
      const blocked = authBlocked(ip);
      if (blocked > 0) {
        send(429, { ok: false, msg: `失败次数过多，请 ${blocked} 秒后再试` });
        return;
      }
      if (!authTryLimit.get(ip).allow()) {
        send(429, { ok: false, msg: '尝试过于频繁，请稍后再试' });
        return;
      }
      let parsed: { name?: unknown; password?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        /* 忽略解析失败 */
      }
      if (parsed == null || typeof parsed !== 'object') parsed = {}; // 字面量 null/原始值：归一化防解引用异常挂起连接
      const r = authLogin(parsed.name, parsed.password);
      if (!r.ok) {
        recordAuthFail(ip);
        send(401, { ok: false, msg: r.msg });
        return;
      }
      authFails.delete(ip);
      send(200, { ok: true, token: r.token, account: r.account });
    })
      .catch(() => {
        /* body 超限已断开连接 */
      });
    return;
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    // 登出 = 吊销令牌（黑名单落盘，重启仍有效）。无论令牌是否有效恒返回 200（不泄露有效性）
    void readBody(req)
      .then(() => {
        const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '');
        if (m?.[1]) revokeToken(m[1]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        /* body 超限已断开连接 */
      });
    return;
  }
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const send = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const acc = authAccount(req);
    if (!acc) {
      send(401, { ok: false, msg: '未登录或登录已过期' });
      return;
    }
    // 60s 缓存：个人战绩不必秒级实时，但每次请求都要全量扫描对局记录（放大风险见 meCache 注释）
    const hit = meCache.get(acc.accountId);
    if (hit && Date.now() - hit.at < 60_000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(hit.body);
      return;
    }
    const ladder = accountLadder(acc.accountId);
    const body = JSON.stringify({
      ok: true,
      account: { id: acc.accountId, name: acc.name },
      ladder: ladder ?? { points: 0, wins: 0 },
      stats: matchPlayerStats(acc.accountId),
    });
    meCache.set(acc.accountId, { at: Date.now(), body });
    if (meCache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of meCache) if (now - v.at > 120_000) meCache.delete(k);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  if (url.pathname === '/api/info') {
    // 内网地址清单只下发给内网来源：公网访客拿到它纯属服务器信息泄漏
    const priv = isPrivateIp(clientIp(req));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ port: PORT, lan: priv ? lanIps : [], tailscale: priv ? tailscaleIps : [] }));
    return;
  }
  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    void readBody(req).then((body) => {
      const send = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (!ADMIN_KEY) {
        send(503, { ok: false, msg: '服务器未设置 ADMIN_KEY，管理员功能未启用' });
        return;
      }
      const blocked = loginBlocked(req);
      if (blocked > 0) {
        send(429, { ok: false, msg: `失败次数过多，请 ${blocked} 秒后再试` });
        return;
      }
      let key = '';
      try {
        key = String((JSON.parse(body) as { key?: unknown }).key ?? '');
      } catch {
        /* 忽略解析失败 */
      }
      if (!safeEqual(key, ADMIN_KEY)) {
        recordLoginFail(req);
        send(401, { ok: false, msg: '管理密码错误' });
        return;
      }
      loginFails.delete(clientIp(req));
      send(200, { ok: true, token: issueAdminToken() });
    })
      .catch(() => {
        /* body 超限已断开连接：无需响应，但必须接住拒绝防进程崩溃 */
      });
    return;
  }
  if (url.pathname === '/api/admin/rooms' && req.method === 'GET') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: manager.listRooms() }));
    return;
  }
  if (url.pathname === '/api/admin/rooms/clear' && req.method === 'POST') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    const n = manager.clearAllRooms();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, cleared: n }));
    return;
  }
  if (url.pathname === '/api/admin/feedback/clear' && req.method === 'POST') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    clearFeedback();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/api/rooms/clear' && req.method === 'POST') {
    // 本机运维接口：只允许服务器自身调用；外部请走管理员登录
    if (!isLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '仅限服务器本机调用（外部请使用管理员登录）' }));
      return;
    }
    const n = manager.clearAllRooms();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, cleared: n }));
    return;
  }
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    void readBody(req).then((body) => {
      const send = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      let parsed: { text?: unknown; contact?: unknown; room?: unknown; name?: unknown } = {};
      try {
        const raw = JSON.parse(body) as unknown;
        // JSON.parse('null') 是合法 JSON，但得到 null —— 直接丢给 submitFeedback 会抛 TypeError，
        // 被下方空 catch 吞掉，于是**永不响应**：客户端挂到 nginx 超时才报错，期间还占着一条上游连接
        if (raw != null && typeof raw === 'object') parsed = raw as typeof parsed;
      } catch {
        /* 忽略解析失败，按空内容处理 */
      }
      const err = submitFeedback(parsed, clientIp(req));
      if (err === 'EMPTY') {
        send(400, { ok: false, msg: '反馈内容不能为空' });
      } else if (err === 'TOO_LONG') {
        send(400, { ok: false, msg: `反馈内容过长（最多 ${500} 字）` });
      } else if (err === 'RATE_LIMITED') {
        send(429, { ok: false, msg: '反馈提交过于频繁，请 1 小时后再试' });
      } else {
        send(200, { ok: true, msg: '反馈已提交，感谢你的帮助！' });
      }
    })
      .catch(() => {
        /* body 超限已断开连接：无需响应，但必须接住拒绝防进程崩溃 */
      });
    return;
  }
  if (url.pathname === '/api/admin/feedback' && req.method === 'GET') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, feedback: listFeedback() }));
    return;
  }
  if (url.pathname === '/api/admin/matches' && req.method === 'GET') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    const all = listMatches();
    // 近期对局关联操作审计（保留 2 天）：auditKey/sameIp 供管理端渲染「详情」入口与同 IP 提示
    const recent = all.slice(-60).reverse().map((e) => {
      const found = e.room != null && e.startedAt != null ? findAudit(e.room, e.startedAt) : null;
      return { ...e, ...(found ? { auditKey: found.key, ...(found.sameIp ? { auditSameIp: found.sameIp } : {}) } : {}) };
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, stats: matchStats(), recent }));
    return;
  }
  if (url.pathname === '/api/admin/matches/clear' && req.method === 'POST') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    clearMatches();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/api/admin/dau' && req.method === 'GET') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        // 实时面：当前 WS 连接 / 房间 / 进行中对局
        online: wss.clients.size,
        rooms: manager.roomCount(),
        games: manager.countActiveGames(),
        days: dauSummary(30),
      }),
    );
    return;
  }
  if (url.pathname === '/api/admin/audit/game' && req.method === 'GET') {
    if (!isAdmin(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或会话已过期' }));
      return;
    }
    const key = String(url.searchParams.get('key') ?? '').slice(0, 64);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, game: loadAuditGame(key) }));
    return;
  }
  // 未知 /api/* 一律 404 JSON：此前会落到下面的静态回退，返回 **200 + index.html**，
  // 客户端只能靠 content-type 猜（老服务端没有新接口时尤其容易误判为"接口正常"）
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, msg: '接口不存在' }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  serveStatic(url.pathname, res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

initFeedbackStore(path.resolve(process.cwd(), 'data', 'feedback.jsonl'));
initMatchStore(path.resolve(process.cwd(), 'data', 'matches.jsonl'));
initAuthStore(
  path.resolve(process.cwd(), 'data', 'users.jsonl'),
  path.resolve(process.cwd(), 'data', 'points.jsonl'),
  path.resolve(process.cwd(), 'data', 'auth-secret'),
);
initAuthRevocations(path.resolve(process.cwd(), 'data', 'auth-revoked.jsonl'));

// 公网滥用防护：全局并发上限 / 单 IP 并发与新建连接频率
// 1200 ≈ 千人同时在线余量（1GB 内存实测 1000 连接约占 150-250MB，先于内存见顶的是这个常量）
const MAX_TOTAL_CONNS = 1200;
// 单 IP 并发上限：放宽以容忍 CGNAT（运营商出口大量用户共享同一公网 IP，曾因 /ws 缺 XFF 全站挤在 127.0.0.1 而形同虚设）；
// 全局 1200 与新建频率限速仍兜底
const MAX_CONNS_PER_IP = 30;
const ipConns = new Map<string, number>();
const ipNewConn = new IpTable(
  () => new SlidingWindow(60_000, 30), // 单 IP 新建连接 30/分：CGNAT 出口多人同时打开属正常流量
  (w, now) => w.idle(now),
);
setInterval(() => ipNewConn.prune(), 5 * 60_000).unref();
setInterval(() => {
  // 登录失败表清理：锁定已过期的直接删除；未达锁定阈值的陈旧条目（10 分钟无新失败）也删，防慢性泄漏
  const stale = Date.now() - 10 * 60_000;
  for (const [ip, rec] of loginFails) {
    if ((rec.until > 0 && Date.now() >= rec.until) || (rec.until === 0 && rec.last < stale)) loginFails.delete(ip);
  }
  for (const [ip, rec] of authFails) {
    if ((rec.until > 0 && Date.now() >= rec.until) || (rec.until === 0 && rec.last < stale)) authFails.delete(ip);
  }
  regLimit.prune();
  authTryLimit.prune();
  apiLimit.prune(); // 通用 API 限流表：同样是按 IP 命中即建条目，须清理防慢性膨胀
  pruneRevocations();
  chatHub.prune(); // 聊天限流表：按 IP 命中即建条目，同样须周期清理
}, 5 * 60_000).unref();

// 全服聊天：广播给所有连接；身份=登录账号名/匿名昵称（清洗+注册名保护+路人兜底）；
// 历史落盘 data/chat.jsonl（重启不丢，内存仍封顶 80 条）
const chatHub = new ChatHub({
  send: (ws, msg) => {
    try {
      (ws as { readyState?: number; OPEN?: number; send?: (d: string) => void }).send?.(JSON.stringify(msg));
    } catch {
      /* 连接已失效，忽略 */
    }
  },
  broadcast: (msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === c.OPEN) {
        try {
          c.send(data);
        } catch {
          /* 忽略 */
        }
      }
    }
  },
  resolveIdentity: (ws, name, auth) => {
    const acc = verifyToken(auth);
    if (acc) return { name: acc.name, account: true };
    // 匿名身份按连接固化：首条消息解析后挂在 ws 上，后续忽略客户端带来的 name
    //（否则同一条连接可逐条换名，伪装成多个不同的人）
    const w = ws as { chatIdentity?: { name: string; account: boolean }; chatFallbackName?: string };
    if (w.chatIdentity) return w.chatIdentity;
    let n = cleanAccountName(name);
    if (!n) {
      // 每连接稳定的路人名（懒生成挂在 ws 上）
      w.chatFallbackName ??= `路人${Math.floor(Math.random() * 90 + 10)}`;
      n = w.chatFallbackName;
    }
    // 注册名保护（与 addSession 同口径并扩展到衍生形态）：
    // 匿名不得采用已注册昵称，也不得直接占用「已注册昵称#N」的衍生形态
    const baseOf = (x: string): string | null => {
      const m = /^(.+)#\d+$/.exec(x);
      return m ? m[1]! : null;
    };
    const taken = (x: string): boolean => isNameRegistered(x) || (baseOf(x) != null && isNameRegistered(baseOf(x)!));
    if (taken(n)) {
      let i = 2;
      let cand = `${n.slice(0, 10)}#${i}`;
      while (isNameRegistered(cand)) {
        i += 1;
        cand = `${n.slice(0, 10)}#${i}`;
      }
      n = cand;
    }
    w.chatIdentity = { name: n, account: false };
    return w.chatIdentity;
  },
});

chatHub.initChatStore(path.resolve(process.cwd(), 'data', 'chat.jsonl'));
initDauStore(path.resolve(process.cwd(), 'data', 'dau.json'));
initAuditStore(path.resolve(process.cwd(), 'data', 'audit'));

// 退出前把日活快照落盘（pm2 restart 发 SIGINT；同步写，毫秒级）——否则每次发版丢最多 60s 的当日记录
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    try {
      flushDau();
    } catch {
      /* 退出路径尽力而为 */
    }
    process.exit(0);
  });
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  (ws as unknown as { ip?: string }).ip = ip;
  // 心跳：初始存活 + pong 应答复位（缺 pong 监听会让每条连接 30-60s 被误杀一轮，见 heartbeat.ts）
  attachHeartbeat(ws as unknown as HeartSocket);
  // 新建连接频率超限：直接拒绝
  if (!ipNewConn.get(ip).allow()) {
    ws.close(4008, 'rate limited');
    return;
  }
  // 总并发 / 单 IP 并发超限：直接拒绝
  if (wss.clients.size >= MAX_TOTAL_CONNS || (ipConns.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
    ws.close(4008, 'too many connections');
    return;
  }
  ipConns.set(ip, (ipConns.get(ip) ?? 0) + 1);
  recordConnection(ip); // 日活：仅统计被接受的连接（配额拒绝的脚本流量不算活跃）
  ws.on('close', () => {
    const left = (ipConns.get(ip) ?? 1) - 1;
    if (left <= 0) ipConns.delete(ip);
    else ipConns.set(ip, left);
  });
  // 全服聊天前置拦截：按 raw 前缀识别并消费（含 chatHistory），其余进房间分发层
  ws.on('message', (raw) => {
    if (chatHub.onRaw(ws, String(raw))) return;
  });
  manager.handleConnection(ws);
});

// 心跳：清掉死连接（pong 复位与假时钟测试见 net/heartbeat.ts）
startHeartbeat(() => wss.clients as unknown as Iterable<HeartSocket>);

// 房间驱动：超时托管 / 结算推进 / 空房清理（兜底 try/catch：tick 内未预期异常不得击穿进程）
// 排水：deploy.sh 重启前写入 server/.draining 标记，检测到后向对局广播更新公告
const DRAIN_MARKER = path.resolve(process.cwd(), '.draining');
let tickSeq = 0;
setInterval(() => {
  try {
    // 排水标记降频检查：每拍（2 次/秒）同步 stat 一次磁盘对 1 核小机是纯浪费，
    // 且它与 tickAll 共用一个 catch —— existsSync 出问题会被记成「房间驱动异常」，
    // 掩盖 tickAll 自身按房间隔离的异常处理。5s 粒度足够（deploy.sh 以 10s 轮询等待排水）。
    if (tickSeq++ % 10 === 0) manager.setDraining(fs.existsSync(DRAIN_MARKER));
    manager.tickAll();
  } catch (e) {
    console.error('[tick] 房间驱动异常:', e);
  }
}, 500).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('==========================================');
  console.log('  血色牌局 · 德州扑克联机服务器已启动');
  console.log('==========================================');
  console.log(`本机游玩:   http://localhost:${PORT}`);
  for (const ip of tailscaleIps) {
    console.log(`Tailscale:  http://${ip}:${PORT}  （异地朋友用这个）`);
  }
  for (const ip of lanIps) {
    console.log(`局域网好友: http://${ip}:${PORT}`);
  }
  console.log('------------------------------------------');
  console.log('好友在浏览器打开上方地址，输入房间码即可加入');
  if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    console.log('[提示] 未检测到前端构建产物，请先运行: npm run build');
  }
});
