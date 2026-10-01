import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { clearFeedback, initFeedbackStore, listFeedback, submitFeedback } from './feedback';
import { clearMatches, initMatchStore, listMatches, matchCharLeaderboard, matchStats } from './matchlog';
import { IpTable, SlidingWindow } from './net/limits';
import { RoomManager } from './rooms';

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIST = path.resolve(process.cwd(), '../client/dist');
/** 管理员密钥（环境变量 ADMIN_KEY；未设置时管理员功能停用） */
const ADMIN_KEY = process.env.ADMIN_KEY ?? '';
/** 管理员会话 token → 过期时间（24h） */
const adminTokens = new Map<string, number>();
/** 管理登录失败限速：IP → 失败次数与锁定截止时间 */
const loginFails = new Map<string, { count: number; until: number }>();

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
  const rec = loginFails.get(ip) ?? { count: 0, until: 0 };
  rec.count += 1;
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

/** 读取 POST 请求的 JSON body（超过 64KB 直接断开连接，拒绝继续接收） */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
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
    // SPA 回退
    filePath = path.join(root, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

/** 公开角色胜率榜缓存（60s）：防刷同时省去每次全量聚合 */
let publicStatsCache: { at: number; body: string } | null = null;

const manager = new RoomManager();

const server = http.createServer((req, res) => {
  // 基础安全头（对全部响应生效，含静态与 API）
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const url = new URL(req.url ?? '/', 'http://localhost');
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
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: manager.roomCount() }));
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
        parsed = JSON.parse(body) as typeof parsed;
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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, stats: matchStats(), recent: all.slice(-30).reverse() }));
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
  // 管理登录失败表清理：锁定已过期的条目直接删除
  for (const [ip, rec] of loginFails) {
    if (rec.until > 0 && Date.now() >= rec.until) loginFails.delete(ip);
  }
}, 5 * 60_000).unref();

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  (ws as unknown as { ip?: string }).ip = ip;
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
  ws.on('close', () => {
    const left = (ipConns.get(ip) ?? 1) - 1;
    if (left <= 0) ipConns.delete(ip);
    else ipConns.set(ip, left);
  });
  manager.handleConnection(ws);
});

// 心跳：清掉死连接
setInterval(() => {
  for (const ws of wss.clients) {
    const alive = (ws as unknown as { isAlive?: boolean }).isAlive !== false;
    if (!alive) {
      ws.terminate();
      continue;
    }
    (ws as unknown as { isAlive?: boolean }).isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

// 房间驱动：超时托管 / 结算推进 / 空房清理（兜底 try/catch：tick 内未预期异常不得击穿进程）
setInterval(() => {
  try {
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
