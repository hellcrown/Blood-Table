import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
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
  const ip = req.socket.remoteAddress ?? '?';
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.until > 0 && Date.now() >= rec.until) {
    loginFails.delete(ip);
    return 0;
  }
  return rec.until > 0 ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
}

function recordLoginFail(req: http.IncomingMessage): void {
  const ip = req.socket.remoteAddress ?? '?';
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

/** 读取 POST 请求的 JSON body */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
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
  let filePath = path.normalize(path.join(root, rel));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA 回退
    filePath = path.join(root, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建：请先执行 npm run build（开发模式请访问 Vite 端口 5173）');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const manager = new RoomManager();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: manager.roomCount() }));
    return;
  }
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ port: PORT, lan: lanIps, tailscale: tailscaleIps }));
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
      if (key !== ADMIN_KEY) {
        recordLoginFail(req);
        send(401, { ok: false, msg: '管理密码错误' });
        return;
      }
      loginFails.delete(req.socket.remoteAddress ?? '?');
      send(200, { ok: true, token: issueAdminToken() });
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  serveStatic(url.pathname, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => manager.handleConnection(ws));

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

// 房间驱动：超时托管 / 结算推进 / 空房清理
setInterval(() => manager.tickAll(), 500).unref();

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
