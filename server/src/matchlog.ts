/**
 * 对局记录落库：JSONL 追加 + 内存全量索引（供管理端统计聚合）。
 * - 文件：server/data/matches.jsonl，每行一条对局摘要（players 按名次升序）
 * - 写入点：RoomManager.broadcast 检测到 gs.final 首次出现时调用 recordMatch（房间内 matchLogged 哨兵防重）
 * - 重启：initMatchStore 从文件全量恢复（坏行跳过）；超上限轮转保留最近条目
 */
import fs from 'node:fs';
import path from 'node:path';

export interface MatchPlayerRow {
  name: string;
  seat: number;
  /** 注册账号 id（登录态玩家才有；机器人/匿名玩家没有） */
  accountId?: string;
  /** 名次（1 = 冠军，按 ranking 顺序） */
  rank: number;
  /** 血色模式：角色 id */
  charId?: string;
  /** 血色模式：车票/血筹 */
  tickets?: number;
  blood?: number;
  /** 德州模式：终局筹码 */
  chips?: number;
  /** 服务端机器人 */
  isBot?: boolean;
  /** 曾被超时托管代打 */
  wasAuto?: boolean;
}

export interface MatchEntry {
  /** 终局时间（epoch ms） */
  endedAt: number;
  /** 对局时长（分钟，开局时间可得时记录） */
  durationMin?: number;
  mode: 'blood' | 'classic';
  seatCount: number;
  /** 冠军座位 */
  winnerSeat: number;
  /** 房间码 + 开局时间：与操作审计（audit.ts，保留 2 天）关联的主键；旧记录无此字段 */
  room?: string;
  startedAt?: number;
  /** 血色：本局以投降结束（胜者按剩余玩家票数排序产生，票数可远低于目标） */
  resigned?: boolean;
  /** 血色：目标票数/拓展开关；德州：盲注与起始筹码 */
  settings?: {
    targetTickets?: number;
    charExpansion?: boolean;
    expansion?: boolean;
    sb?: number;
    bb?: number;
    startChips?: number;
  };
  players: MatchPlayerRow[];
}

export interface CharStat {
  charId: string;
  games: number;
  wins: number;
  /** 胜率（百分比，1 位小数） */
  winRate: number;
  /** 平均名次（null = 无数据） */
  avgRank: number | null;
}

export interface MatchStats {
  total: number;
  /** 近 7 天对局数 */
  last7d: number;
  avgDurationMin: number | null;
  /** 机器人座位占总座位百分比（1 位小数） */
  botShare: number;
  byMode: Record<string, number>;
  /** 角色出场/胜率聚合（按出场次数降序，前 12） */
  chars: CharStat[];
}

const MAX_MATCHES = 20_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ROTATE_KEEP = 10_000;

let file: string | null = null;
const list: MatchEntry[] = [];

/** 启动时调用：全量恢复（目录自动创建，坏行跳过） */
export function initMatchStore(filePath: string): void {
  file = filePath;
  list.length = 0;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
      return;
    }
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as MatchEntry;
        if (
          typeof entry?.endedAt === 'number' &&
          (entry.mode === 'blood' || entry.mode === 'classic') &&
          Array.isArray(entry?.players)
        ) {
          list.push(entry);
        }
      } catch {
        /* 尾部半行或坏行：跳过 */
      }
    }
    if (list.length > MAX_MATCHES) list.splice(0, list.length - MAX_MATCHES);
  } catch (e) {
    console.error('[matchlog] 初始化存储失败（对局记录暂存内存）:', e);
  }
}

/** 终局落库：内存追加 + 文件追加；超限轮转 */
export function recordMatch(entry: MatchEntry): void {
  list.push(entry);
  if (list.length > MAX_MATCHES) list.splice(0, list.length - MAX_MATCHES);
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    if (fs.statSync(file).size > MAX_FILE_BYTES) {
      const keep = list.slice(-ROTATE_KEEP);
      // 先写临时文件再原子改名：覆盖式重写期间崩溃会把正式文件截断成半截（历史记录不可恢复）
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, keep.map((m) => JSON.stringify(m)).join('\n') + '\n');
      fs.renameSync(tmp, file);
    }
  } catch (e) {
    console.error('[matchlog] 落盘失败（已保留内存）:', e);
  }
}

export interface CharLeaderRow {
  charId: string;
  games: number;
  wins: number;
  /** 胜率（百分比，1 位小数） */
  winRate: number;
  /** 平均名次 */
  avgRank: number;
}

/** 角色胜率榜（公开接口用）：仅统计血色局，出场 ≥ minGames 才计入；按胜率降序（并列按出场多者在前） */
export function matchCharLeaderboard(minGames = 5): CharLeaderRow[] {
  const agg = new Map<string, { games: number; wins: number; rankSum: number }>();
  for (const m of list) {
    if (m.mode !== 'blood') continue;
    for (const pl of m.players) {
      if (!pl.charId) continue;
      const a = agg.get(pl.charId) ?? { games: 0, wins: 0, rankSum: 0 };
      a.games++;
      a.rankSum += pl.rank;
      if (pl.rank === 1) a.wins++;
      agg.set(pl.charId, a);
    }
  }
  return [...agg.entries()]
    .filter(([, a]) => a.games >= minGames)
    .map(([charId, a]) => ({
      charId,
      games: a.games,
      wins: a.wins,
      winRate: Math.round((a.wins / a.games) * 1000) / 10,
      avgRank: Math.round((a.rankSum / a.games) * 100) / 100,
    }))
    .sort((x, y) => y.winRate - x.winRate || y.games - x.games);
}

/** 管理端：全部记录（内存副本） */
export function listMatches(): MatchEntry[] {
  return list.slice();
}

export interface PlayerMatchRow {
  endedAt: number;
  mode: 'blood' | 'classic';
  durationMin?: number;
  seatCount: number;
  rank: number;
  charId?: string;
  tickets?: number;
  blood?: number;
  chips?: number;
}

export interface PlayerStats {
  games: number;
  wins: number;
  /** 平均名次（null = 无数据） */
  avgRank: number | null;
  /** 分角色统计（按出场次数降序） */
  chars: CharStat[];
  /** 最近 10 局（新→旧） */
  recent: PlayerMatchRow[];
}

/** 个人战绩：按 accountId 聚合全部落库对局（登录后 /api/auth/me 用） */
export function matchPlayerStats(accountId: string): PlayerStats | null {
  let games = 0;
  let wins = 0;
  let rankSum = 0;
  const chars = new Map<string, { games: number; wins: number; rankSum: number }>();
  const recent: PlayerMatchRow[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    // 同账号可能在同局占多座（双标签页）：逐行全部计入
    for (const pl of m.players) {
      if (pl.accountId !== accountId) continue;
      games++;
      rankSum += pl.rank;
      if (pl.rank === 1) wins++;
      if (pl.charId && m.mode === 'blood') {
        const a = chars.get(pl.charId) ?? { games: 0, wins: 0, rankSum: 0 };
        a.games++;
        a.rankSum += pl.rank;
        if (pl.rank === 1) a.wins++;
        chars.set(pl.charId, a);
      }
      if (recent.length < 10) {
        recent.push({
          endedAt: m.endedAt,
          mode: m.mode,
          ...(m.durationMin != null ? { durationMin: m.durationMin } : {}),
          seatCount: m.seatCount,
          rank: pl.rank,
          ...(pl.charId ? { charId: pl.charId } : {}),
          ...(pl.tickets != null ? { tickets: pl.tickets } : {}),
          ...(pl.blood != null ? { blood: pl.blood } : {}),
          ...(pl.chips != null ? { chips: pl.chips } : {}),
        });
      }
    }
  }
  if (games === 0) return null;
  const charsOut: CharStat[] = [...chars.entries()]
    .map(([charId, a]) => ({
      charId,
      games: a.games,
      wins: a.wins,
      winRate: Math.round((a.wins / a.games) * 1000) / 10,
      avgRank: Math.round((a.rankSum / a.games) * 100) / 100,
    }))
    .sort((a, b) => b.games - a.games);
  return { games, wins, avgRank: Math.round((rankSum / games) * 100) / 100, chars: charsOut, recent };
}

/** 管理端清空（内存与文件） */
export function clearMatches(): void {
  list.length = 0;
  if (file) {
    try {
      fs.writeFileSync(file, '');
    } catch (e) {
      console.error('[matchlog] 清空文件失败:', e);
    }
  }
}

/** 统计聚合（管理端展示用） */
/** matchStats 全量聚合（2 万条 × 座位）缓存：管理端刷新共用，按条数+末条终局时间+日期桶失效 */
let statsCache: { key: string; value: MatchStats } | null = null;

export function matchStats(now = Date.now()): MatchStats {
  // 键必须含日期桶：last7d 依赖「现在」，键不变时缓存会让「近 7 天」跨日冻结
  const cacheKey = `${list.length}:${list[list.length - 1]?.endedAt ?? 0}:${Math.floor(now / 86_400_000)}`;
  if (statsCache?.key === cacheKey) return statsCache.value;
  let seats = 0;
  let botSeats = 0;
  let last7d = 0;
  let durSum = 0;
  let durCount = 0;
  const byMode: Record<string, number> = {};
  const charAgg = new Map<string, { games: number; wins: number; rankSum: number }>();
  for (const m of list) {
    if (now - m.endedAt <= 7 * 86_400_000) last7d++;
    byMode[m.mode] = (byMode[m.mode] ?? 0) + 1;
    if (typeof m.durationMin === 'number' && m.durationMin > 0) {
      durSum += m.durationMin;
      durCount++;
    }
    for (const pl of m.players) {
      seats++;
      if (pl.isBot) botSeats++;
      if (m.mode === 'blood' && pl.charId) {
        const agg = charAgg.get(pl.charId) ?? { games: 0, wins: 0, rankSum: 0 };
        agg.games++;
        agg.rankSum += pl.rank;
        if (pl.rank === 1) agg.wins++;
        charAgg.set(pl.charId, agg);
      }
    }
  }
  const chars: CharStat[] = [...charAgg.entries()]
    .map(([charId, a]) => ({
      charId,
      games: a.games,
      wins: a.wins,
      winRate: a.games ? Math.round((a.wins / a.games) * 1000) / 10 : 0,
      avgRank: a.games ? Math.round((a.rankSum / a.games) * 100) / 100 : null,
    }))
    .sort((a, b) => b.games - a.games)
    .slice(0, 12);
  const result: MatchStats = {
    total: list.length,
    last7d,
    avgDurationMin: durCount ? Math.round((durSum / durCount) * 10) / 10 : null,
    botShare: seats ? Math.round((botSeats / seats) * 1000) / 10 : 0,
    byMode,
    chars,
  };
  statsCache = { key: cacheKey, value: result };
  return result;
}
