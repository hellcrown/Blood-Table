/**
 * 对局操作审计：按局记录每个玩家的操作与房间聊天（含时间/身份/IP），供管理端排查作弊。
 * - 存储：server/data/audit/audit-YYYYMMDD.jsonl，每天一个文件、逐条追加（崩溃安全）；
 *   只保留今天+昨天两个文件（init 与每小时清理更旧的）
 * - 行类型：start（开局快照：座位/昵称/账号/bot/IP/同IP标记）｜act（操作尝试，含被规则拒绝的——
 *   刷非法消息本身是作弊探针）｜chat（房间聊天）｜end（终局：结果摘要 + 引擎叙述 log）
 * - 一局的唯一 key = `${房间码}:${开局毫秒时间戳}`；classic handleRematch 已改为重置
 *   gameStartedAt（与血色 bRematch 对齐），否则重开局的 key 会撞车
 * - 内存只驻留「对局索引」（start/end 摘要）；动作明细按 key 从当日/昨日文件扫描，查看时才读盘
 * - 未 initAuditStore（测试不传目录 / 未调用）时接口返回空、写入为 no-op
 */
import fs from 'node:fs';
import path from 'node:path';

const KEEP_FILES = 2; // 今天 + 昨天
const SWEEP_MS = 60 * 60_000;

export interface AuditPlayer {
  seat: number;
  name: string;
  accountId?: string;
  bot?: boolean;
  ip?: string;
}

export interface AuditGameIndex {
  key: string;
  room: string;
  mode: 'blood' | 'classic';
  startedAt: number;
  endedAt?: number;
  durationMin?: number;
  seatCount: number;
  players: AuditPlayer[];
  /** 非 bot 座位中共享同一 IP 的座位（线索非定罪：CGNAT 出口可能合并真人） */
  sameIp?: number[];
  winnerSeat?: number;
}

export interface AuditActionLine {
  k: 'act' | 'chat';
  key: string;
  ts: number;
  seat: number;
  name: string;
  accountId?: string;
  /** msg.t（act 行）或 'chat'（chat 行） */
  t: string;
  /** act 行的消息参数（已剔除 t/auth/adminToken/name）；chat 行为文本 */
  p?: unknown;
}

export interface AuditGameDetail {
  start: { key: string; room: string; mode: 'blood' | 'classic'; startedAt: number; players: AuditPlayer[]; sameIp?: number[]; settings?: unknown };
  end?: { endedAt: number; durationMin?: number; winnerSeat?: number; summary: unknown; log?: unknown };
  acts: AuditActionLine[];
}

let dir: string | null = null;
/** 对局索引：插入序（按开局先后），展示时反转 */
const index = new Map<string, AuditGameIndex>();

const dayTag = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};
const todayFile = (): string => `audit-${dayTag(new Date())}.jsonl`;

function filePathFor(name: string): string {
  return path.join(dir!, name);
}

/** 追加一行（appendFileSync 逐条落盘；未初始化或写入失败静默降级——审计不可阻断对局） */
function appendLine(line: object): void {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePathFor(todayFile()), `${JSON.stringify(line)}\n`);
  } catch (e) {
    console.error('[audit] 审计写入失败（不影响对局）:', e);
  }
}

/** 非 bot 座位中共享同一 IP 的座位列表（≥2 人才返回） */
function sameIpSeats(players: AuditPlayer[]): number[] | undefined {
  const byIp = new Map<string, number[]>();
  for (const p of players) {
    if (p.bot || !p.ip) continue;
    const list = byIp.get(p.ip) ?? [];
    list.push(p.seat);
    byIp.set(p.ip, list);
  }
  const dupes = [...byIp.values()].filter((seats) => seats.length >= 2).flat();
  return dupes.length > 0 ? dupes.sort((a, b) => a - b) : undefined;
}

/** 开局（handleStart / 血色 bRematch / classic handleRematch） */
export function recordGameStart(input: {
  room: string;
  mode: 'blood' | 'classic';
  startedAt: number;
  settings?: unknown;
  players: AuditPlayer[];
}): void {
  if (!dir) return;
  const sameIp = sameIpSeats(input.players);
  const idx: AuditGameIndex = {
    key: `${input.room}:${input.startedAt}`,
    room: input.room,
    mode: input.mode,
    startedAt: input.startedAt,
    seatCount: input.players.length,
    players: input.players,
    ...(sameIp ? { sameIp } : {}),
  };
  index.set(idx.key, idx);
  appendLine({ k: 'start', ...idx, ...(input.settings != null ? { settings: input.settings } : {}) });
}

/** 操作尝试（handleBlood / handleAct 入口；含将被规则拒绝的消息） */
export function recordAction(input: {
  key: string;
  ts: number;
  seat: number;
  name: string;
  accountId?: string;
  t: string;
  p?: unknown;
}): void {
  if (!dir || !index.has(input.key)) return; // 未开局/旧局残留消息不记
  const line: AuditActionLine = {
    k: 'act',
    key: input.key,
    ts: input.ts,
    seat: input.seat,
    name: input.name,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    t: input.t,
    ...(input.p != null ? { p: input.p } : {}),
  };
  appendLine(line);
}

/** 房间聊天（handleRoomChat 广播前；限频已通过） */
export function recordChat(input: { key: string; ts: number; seat: number; name: string; accountId?: string; text: string }): void {
  if (!dir || !index.has(input.key)) return;
  appendLine({ k: 'chat', t: 'chat', ...input });
}

/** 终局（maybeRecordFinal；matchLogged 哨兵保证每局一次） */
export function recordGameEnd(input: {
  key: string;
  endedAt: number;
  durationMin?: number;
  winnerSeat?: number;
  summary: unknown;
  log?: unknown;
}): void {
  if (!dir) return;
  const idx = index.get(input.key);
  if (idx) {
    idx.endedAt = input.endedAt;
    if (input.durationMin != null) idx.durationMin = input.durationMin;
    if (input.winnerSeat != null) idx.winnerSeat = input.winnerSeat;
  }
  appendLine({
    k: 'end',
    key: input.key,
    endedAt: input.endedAt,
    ...(input.durationMin != null ? { durationMin: input.durationMin } : {}),
    ...(input.winnerSeat != null ? { winnerSeat: input.winnerSeat } : {}),
    summary: input.summary,
    ...(input.log != null ? { log: input.log } : {}),
  });
}

/** 删除超过保留窗口（今天+昨天之外）的审计文件 */
function sweepOldFiles(): void {
  if (!dir) return;
  try {
    const keep = new Set<string>();
    const now = new Date();
    keep.add(`audit-${dayTag(now)}.jsonl`);
    keep.add(`audit-${dayTag(new Date(now.getTime() - 86_400_000))}.jsonl`);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('audit-') && f.endsWith('.jsonl') && !keep.has(f)) {
        try {
          fs.unlinkSync(filePathFor(f));
        } catch {
          /* 忽略单个文件清理失败 */
        }
      }
    }
  } catch (e) {
    console.error('[audit] 过期审计清理失败:', e);
  }
}

/** 启动时调用：清理过期文件 → 扫描留存文件重建索引 + 每小时再清理；不调用则纯 no-op */
export function initAuditStore(auditDir: string): void {
  dir = auditDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    sweepOldFiles(); // 先清理再扫描：被删文件的数据不得进内存索引
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort();
    for (const name of names) {
      for (const line of fs.readFileSync(filePathFor(name), 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t) as { k?: string; key?: string } & Record<string, unknown>;
          if (o.k === 'start' && typeof o.key === 'string' && !index.has(o.key)) {
            const players = Array.isArray(o.players) ? (o.players as AuditPlayer[]) : [];
            index.set(o.key, {
              key: o.key,
              room: String(o.room ?? ''),
              mode: o.mode === 'classic' ? 'classic' : 'blood',
              startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
              seatCount: players.length,
              players,
              ...(Array.isArray(o.sameIp) ? { sameIp: o.sameIp as number[] } : {}),
            });
          } else if (o.k === 'end' && typeof o.key === 'string' && index.has(o.key)) {
            const idx = index.get(o.key)!;
            idx.endedAt = typeof o.endedAt === 'number' ? o.endedAt : undefined;
            idx.durationMin = typeof o.durationMin === 'number' ? o.durationMin : undefined;
            idx.winnerSeat = typeof o.winnerSeat === 'number' ? o.winnerSeat : undefined;
          }
        } catch {
          /* 坏行跳过 */
        }
      }
    }
  } catch (e) {
    console.error('[audit] 审计索引加载失败（不影响对局）:', e);
  }
  setInterval(sweepOldFiles, SWEEP_MS).unref();
}

/** 管理端：对局索引（新→旧） */
export function listAuditGames(): AuditGameIndex[] {
  return [...index.values()].reverse();
}

/** 按房间码+开局时间查找审计对局（对局统计「详情」入口的关联键）；无审计记录返回 null */
export function findAudit(room: string, startedAt: number): { key: string; sameIp?: number[] } | null {
  const idx = index.get(`${room}:${startedAt}`);
  if (!idx) return null;
  return { key: idx.key, ...(idx.sameIp ? { sameIp: idx.sameIp } : {}) };
}

/** 管理端：按 key 加载一局的完整时间线（扫留存文件；找不到返回 null） */
export function loadAuditGame(key: string): AuditGameDetail | null {
  const startIdx = index.get(key);
  if (!dir || !startIdx) return null;
  const detail: AuditGameDetail = {
    start: {
      key,
      room: startIdx.room,
      mode: startIdx.mode,
      startedAt: startIdx.startedAt,
      players: startIdx.players,
      ...(startIdx.sameIp ? { sameIp: startIdx.sameIp } : {}),
    },
    acts: [],
  };
  try {
    const names = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
      .sort();
    for (const name of names) {
      for (const line of fs.readFileSync(filePathFor(name), 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || !t.includes(`"${key}"`)) continue; // 快速预筛，避免逐行 JSON.parse
        try {
          const o = JSON.parse(t) as { k?: string; key?: string };
          if (o.key !== key) continue;
          if (o.k === 'act' || o.k === 'chat') detail.acts.push(o as AuditActionLine);
          else if (o.k === 'end') {
            const e = o as unknown as { endedAt: number; durationMin?: number; winnerSeat?: number; summary: unknown; log?: unknown };
            detail.end = { endedAt: e.endedAt, durationMin: e.durationMin, winnerSeat: e.winnerSeat, summary: e.summary, log: e.log };
          }
        } catch {
          /* 坏行跳过 */
        }
      }
    }
  } catch (e) {
    console.error('[audit] 审计明细读取失败:', e);
    return detail; // 读盘失败时至少返回索引摘要
  }
  return detail;
}

/** 测试钩子：清空内存索引（配合 vi.resetModules 隔离用例） */
export function resetAuditForTest(): void {
  index.clear();
}
