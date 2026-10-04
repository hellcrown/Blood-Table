/**
 * 玩家账号系统：注册/登录 + 无状态 HMAC 令牌 + 天梯积分存储。
 * - users.jsonl：追加写，同一 accountId 以最后一条为准（同一昵称唯一，nameLower 索引）
 * - points.jsonl：天梯积分事件追加写（终局胜局计分，匿名局/全机器人局不记录），启动聚合求和，可审计
 * - 令牌：`v1.<accountId>.<expiry36>.<hmac>`，HMAC-SHA256；密钥持久化于 auth-secret（服务器重启不掉登录）
 * 密码哈希用 node:crypto scrypt（自带随机盐），零第三方依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface AccountRow {
  accountId: string;
  name: string;
  /** 唯一性索引键（小写化；昵称本体保留原样） */
  nameLower: string;
  /** scrypt$N$r$p$saltHex$hashHex */
  pw: string;
  createdAt: number;
  lastLogin?: number;
}

export interface LadderEvent {
  accountId: string;
  ts: number;
  /** 对局时长（分钟） */
  durationMin: number;
  /** 冠军车票 */
  tickets: number;
  /** 第二名车票 */
  secondTickets: number;
  /** 本局目标票数 */
  targetTickets: number;
  seatCount: number;
  /** 0~5 综合积分 */
  points: number;
}

export interface AuthedAccount {
  accountId: string;
  name: string;
}

export type AuthResult = { ok: true; account: AuthedAccount; token: string } | { ok: false; code: string; msg: string };

/** 注册昵称下限：1 字昵称放给匿名随意用，注册占名需 2 字起（防单字霸占逼全员改后缀） */
const MIN_NAME = 2;
const MAX_NAME = 12;
const MIN_PW = 6;
const MAX_PW = 32;
/** 登录令牌有效期 30 天（过期后重新登录即可） */
export const AUTH_TTL_MS = 30 * 24 * 3600_000;

/* ---------------- 积分公式阈值（三轴各 0~2 分，合计 clamp 0~5） ---------------- */
/** 时长轴：<10 分钟 0 分，≥10 且 <20 分钟 1 分，≥20 分钟 2 分 */
export const PTS_DURATION_MID = 10;
export const PTS_DURATION_LONG = 20;
/** 本人车票轴（胜时超出目标票数）：<2 → 0，2~4 → 1，≥5 → 2 */
export const PTS_OVERFLOW_1 = 2;
export const PTS_OVERFLOW_2 = 5;
/** 竞争轴（第二名车票距目标的差距）：≤1 票 → 2 分，2~4 票 → 1 分，≥5 票 → 0 分 */
export const PTS_GAP_1 = 1;
export const PTS_GAP_2 = 5;

let usersFile: string | null = null;
let pointsFile: string | null = null;
let secret = '';
/** accountId → 最新账号行 */
const byId = new Map<string, AccountRow>();
/** nameLower → accountId（昵称唯一索引 + 匿名昵称保护） */
const byName = new Map<string, string>();
/** accountId → { points, wins }（points.jsonl 聚合） */
const ladder = new Map<string, { points: number; wins: number }>();

/* ---------------- 令牌吊销（登出即失效） ---------------- */
/** sha256(token) hex → 过期时间。无状态 HMAC 令牌本身无法吊销，登出必须落黑名单 */
const revoked = new Map<string, number>();
let revokedFile: string | null = null;

/** 启动时调用：恢复吊销黑名单（坏行/过期条目跳过；目录自动创建） */
export function initAuthRevocations(revokedPath: string): void {
  revokedFile = revokedPath;
  revoked.clear();
  try {
    fs.mkdirSync(path.dirname(revokedPath), { recursive: true });
    if (!fs.existsSync(revokedPath)) {
      fs.writeFileSync(revokedPath, '');
      return;
    }
    const now = Date.now();
    const keep: string[] = [];
    for (const line of fs.readFileSync(revokedPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as { h?: unknown; exp?: unknown };
        if (typeof row?.h === 'string' && typeof row?.exp === 'number' && row.exp > now) {
          revoked.set(row.h, row.exp);
          keep.push(trimmed);
        }
      } catch {
        /* 坏行跳过 */
      }
    }
    // 重写为仅含未过期条目，防文件无限增长。
    // 必须先写临时文件再原子改名：直接覆盖式重写时若进程被杀/断电，文件会被截断成半截，
    // 而「文件里还在的行」才是启动时加载的吊销名单 —— 丢行 = 已登出的令牌重新生效（30 天 TTL 内）。
    const tmp = revokedPath + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
    fs.renameSync(tmp, revokedPath);
  } catch (e) {
    console.error('[auth] 初始化吊销黑名单失败（登出仅本次进程生效）:', e);
  }
}

/** 清理已过期的吊销条目（周期调用防慢性泄漏） */
export function pruneRevocations(now = Date.now()): void {
  for (const [h, exp] of revoked) if (exp <= now) revoked.delete(h);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 吊销登录令牌（登出用）：令牌须通过格式与 HMAC 校验才记录（不为此泄露有效性信息，调用方恒返回 200）。
 * 黑名单落盘：重启后仍有效。
 */
export function revokeToken(token: unknown): void {
  if (typeof token !== 'string' || !token) return;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return;
  const [, accountId, exp, mac] = parts as [string, string, string, string];
  // HMAC 不匹配的令牌本就无效，无需记录（防黑名单被无关垃圾灌满）
  const expect = createHmac('sha256', secret).update(`${accountId}.${exp}`).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return;
  const expMs = parseInt(exp, 36);
  if (!Number.isFinite(expMs) || expMs <= Date.now()) return;
  const h = tokenHash(token);
  if (revoked.has(h)) return;
  revoked.set(h, expMs);
  if (revokedFile) {
    try {
      fs.appendFileSync(revokedFile, JSON.stringify({ h, exp: expMs }) + '\n');
    } catch (e) {
      console.error('[auth] 吊销记录落盘失败（已保留内存）:', e);
    }
  }
}

/* ---------------- 昵称清洗（与 rooms.cleanName 同口径） ---------------- */

export function cleanAccountName(raw: unknown): string {
  return typeof raw === 'string'
    ? raw
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, MAX_NAME)
    : '';
}

/* ---------------- 存储 ---------------- */

/** 启动时调用：全量恢复 users/points/secret（坏行跳过；目录自动创建；重复调用以文件为准重建索引） */
export function initAuthStore(usersPath: string, pointsPath: string, secretPath: string): void {
  usersFile = usersPath;
  pointsFile = pointsPath;
  byId.clear();
  byName.clear();
  ladder.clear();
  try {
    fs.mkdirSync(path.dirname(usersPath), { recursive: true });
    // users.jsonl：同一 accountId 以最后一条为准（未来支持改密/改名时无需改写历史）
    if (fs.existsSync(usersPath)) {
      for (const line of fs.readFileSync(usersPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed) as AccountRow;
          if (typeof row?.accountId === 'string' && typeof row?.name === 'string' && typeof row?.pw === 'string') {
            byId.set(row.accountId, row);
            byName.set(row.nameLower, row.accountId);
          }
        } catch {
          /* 坏行跳过 */
        }
      }
    } else {
      fs.writeFileSync(usersPath, '');
    }
    // points.jsonl：积分事件聚合（事件行逐条累加；快照行——轮转压缩产物——按合计直接落表）
    if (fs.existsSync(pointsPath)) {
      for (const line of fs.readFileSync(pointsPath, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as LadderEvent & { wins?: number };
          if (typeof ev?.accountId === 'string' && typeof ev?.points === 'number') {
            if (typeof ev.wins === 'number') {
              ladder.set(ev.accountId, { points: ev.points, wins: ev.wins });
            } else {
              addLadder(ev.accountId, ev.points);
            }
          }
        } catch {
          /* 坏行跳过 */
        }
      }
    } else {
      fs.writeFileSync(pointsPath, '');
    }
    // HMAC 密钥：首次启动生成并持久化（重启/重部署后旧 token 仍有效）
    if (fs.existsSync(secretPath)) {
      const s = fs.readFileSync(secretPath, 'utf-8').trim();
      if (/^[0-9a-f]{64}$/i.test(s)) secret = s;
    }
    if (!secret) {
      secret = randomBytes(32).toString('hex');
      fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    }
  } catch (e) {
    console.error('[auth] 初始化存储失败（账号功能暂存内存）:', e);
  }
  // 密钥兜底：加载半途异常会让 secret 保持空串——空密钥 HMAC 等于任何人可自签令牌，必须保证非空
  // （兜底密钥不落盘：重启后再次生成，旧 token 全失效，属可接受的降安全模式）
  if (!secret) secret = randomBytes(32).toString('hex');
}

function appendLine(file: string | null, obj: unknown): void {
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.error('[auth] 落盘失败（已保留内存）:', e);
  }
}

/* ---------------- 密码哈希（scrypt） ---------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/i.exec(stored);
  if (!m) return false;
  try {
    const hash = scryptSync(pw, Buffer.from(m[4]!, 'hex'), m[5]!.length / 2, {
      N: Number(m[1]),
      r: Number(m[2]),
      p: Number(m[3]),
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(hash, Buffer.from(m[5]!, 'hex'));
  } catch {
    return false;
  }
}

/* ---------------- HMAC 令牌 ---------------- */

function sign(payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** 签发登录令牌（ttl 仅供测试注入过期/短时效令牌） */
export function issueToken(accountId: string, ttl: number = AUTH_TTL_MS): string {
  const exp = (Date.now() + ttl).toString(36);
  const payload = `${accountId}.${exp}`;
  return `v1.${payload}.${sign(payload)}`;
}

/**
 * 校验令牌：格式/过期/HMAC/吊销 四重检查；账号仍存在才返回身份
 */
export function verifyToken(token: unknown): AuthedAccount | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, accountId, exp, mac] = parts as [string, string, string, string];
  const payload = `${accountId}.${exp}`;
  const expect = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(exp, 36) < Date.now()) return null;
  if (revoked.has(tokenHash(token))) return null; // 已登出吊销
  const row = byId.get(accountId);
  if (!row) return null;
  return { accountId, name: row.name };
}

/* ---------------- 注册 / 登录 ---------------- */

export function register(nameRaw: unknown, passwordRaw: unknown): AuthResult {
  const name = cleanAccountName(nameRaw);
  if (name.length < MIN_NAME) return { ok: false, code: 'BAD_NAME', msg: `昵称至少 ${MIN_NAME} 个字符（最多 ${MAX_NAME}）` };
  const pw = typeof passwordRaw === 'string' ? passwordRaw : '';
  if (pw.length < MIN_PW || pw.length > MAX_PW) {
    return { ok: false, code: 'BAD_PASSWORD', msg: `密码需 ${MIN_PW}~${MAX_PW} 位` };
  }
  const nameLower = name.toLowerCase();
  if (byName.has(nameLower)) return { ok: false, code: 'NAME_TAKEN', msg: '该昵称已被注册' };
  const row: AccountRow = {
    accountId: randomBytes(8).toString('hex'),
    name,
    nameLower,
    pw: hashPassword(pw),
    createdAt: Date.now(),
    lastLogin: Date.now(),
  };
  byId.set(row.accountId, row);
  byName.set(nameLower, row.accountId);
  appendLine(usersFile, row);
  return { ok: true, account: { accountId: row.accountId, name: row.name }, token: issueToken(row.accountId) };
}

export function login(nameRaw: unknown, passwordRaw: unknown): AuthResult {
  const name = cleanAccountName(nameRaw);
  const accountId = byName.get(name.toLowerCase());
  const row = accountId ? byId.get(accountId) : undefined;
  if (!row || !verifyPassword(typeof passwordRaw === 'string' ? passwordRaw : '', row.pw)) {
    // 对未命中账号同样跑一次 scrypt：抹平「存在/不存在」的响应时序差（防用户枚举）
    dummyVerify(typeof passwordRaw === 'string' ? passwordRaw : '');
    return { ok: false, code: 'BAD_CREDENTIALS', msg: '昵称或密码错误' };
  }
  row.lastLogin = Date.now(); // 仅内存：无消费方读历史 lastLogin，落盘会让 users.jsonl 随每次登录无限增长
  return { ok: true, account: { accountId: row.accountId, name: row.name }, token: issueToken(row.accountId) };
}

/** 内置哑哈希：登录未命中账号时跑一次等价 scrypt，抹平时序（懒初始化） */
let dummyHash: string | null = null;
function dummyVerify(pw: string): boolean {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  return verifyPassword(pw, dummyHash);
}

/** 昵称是否已被注册占用（匿名会话昵称保护用；输入先做同口径清洗） */
export function isNameRegistered(name: string): boolean {
  return byName.has(cleanAccountName(name).toLowerCase());
}

/** 账号当前昵称（房内强制使用，防冒名） */
export function accountName(accountId: string): string | undefined {
  return byId.get(accountId)?.name;
}

/* ---------------- 天梯积分 ---------------- */

function addLadder(accountId: string, points: number): void {
  const cur = ladder.get(accountId) ?? { points: 0, wins: 0 };
  cur.points += points;
  cur.wins += 1;
  ladder.set(accountId, cur);
}

/**
 * 胜局综合积分（0~5）：时长 / 本人车票超出目标的幅度 / 第二名逼近目标的程度，三轴各 0~2 分。
 * 调用方先校验资格（已注册冠军 + 除自己外至少 1 名真人）。
 */
export function computeLadderPoints(
  durationMin: number,
  tickets: number,
  secondTickets: number,
  targetTickets: number,
): number {
  const d = durationMin >= PTS_DURATION_MID ? (durationMin >= PTS_DURATION_LONG ? 2 : 1) : 0;
  const overflow = tickets - targetTickets;
  const o = overflow >= PTS_OVERFLOW_2 ? 2 : overflow >= PTS_OVERFLOW_1 ? 1 : 0;
  const gap = Math.max(0, targetTickets - secondTickets);
  const g = gap <= PTS_GAP_1 ? 2 : gap < PTS_GAP_2 ? 1 : 0;
  return Math.min(5, d + o + g);
}

/** 积分文件轮转阈值：只追加无轮转会随对局数无限膨胀（启动还要全量重放），超限压缩为快照 */
const POINTS_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 终局积分事件落库（资格由调用方校验；points=0 的胜局也记录，累计胜场） */
export function recordLadderEvent(ev: LadderEvent): void {
  addLadder(ev.accountId, ev.points);
  if (!pointsFile) return;
  try {
    fs.appendFileSync(pointsFile, JSON.stringify(ev) + '\n');
    if (fs.statSync(pointsFile).size > POINTS_MAX_FILE_BYTES) {
      // 压缩为各账号合计快照（loader 识别带 wins 的行为快照、直接落表）。
      // 先写临时文件再原子改名：覆盖式重写期间崩溃会把正式文件截断成半截
      const snap = [...ladder.entries()].map(([accountId, a]) => ({ accountId, points: a.points, wins: a.wins }));
      const tmp = pointsFile + '.tmp';
      fs.writeFileSync(tmp, snap.map((e) => JSON.stringify(e)).join('\n') + '\n');
      fs.renameSync(tmp, pointsFile);
    }
  } catch (e) {
    console.error('[auth] 积分落盘失败（已保留内存）:', e);
  }
}

export interface LadderRow {
  accountId: string;
  name: string;
  /** 累计积分 */
  points: number;
  /** 计分胜场 */
  wins: number;
}

/** 天梯榜：按积分降序（并列按胜场多者在前） */
export function ladderBoard(): LadderRow[] {
  return [...ladder.entries()]
    .map(([accountId, a]) => ({ accountId, name: byId.get(accountId)?.name ?? '未知玩家', ...a }))
    .sort((x, y) => y.points - x.points || y.wins - x.wins);
}

/** 个人累计：无记录返回 null */
export function accountLadder(accountId: string): { points: number; wins: number } | null {
  const a = ladder.get(accountId);
  return a ? { ...a } : null;
}

/** 管理端预留：清空积分（不清账号） */
export function clearLadder(): void {
  ladder.clear();
  if (pointsFile) {
    try {
      fs.writeFileSync(pointsFile, '');
    } catch (e) {
      console.error('[auth] 清空积分文件失败:', e);
    }
  }
}
