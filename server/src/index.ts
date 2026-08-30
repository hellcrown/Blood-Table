import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms';

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIST = path.resolve(process.cwd(), '../client/dist');

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
  if (url.pathname === '/api/rooms/clear' && req.method === 'POST') {
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
