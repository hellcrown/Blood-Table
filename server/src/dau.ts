/**
 * 日活统计：按天记录活跃 IP（WS 连接握手）与登录账号（入房会话），供管理端查看。
 * - 采集点：index.ts 每条**被接受**的新连接记一次 IP（含重连；配额拒绝的不算活跃）；
 *   rooms.ts 在会话携带 accountId 时记一次账号（建房/加入/观战/重连/接替均覆盖）
 * - 存储：data/dau.json 单文件快照，脏后 60s 原子写回（tmp+rename），保留最近 180 天；
 *   与 matchlog/feedback 同口径：仅管理端可见，文件不入库（data/ 已 gitignore）
 * - 未 initDauStore（测试/未调用）则纯内存，接口照常可用
 */
import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 180;
const FLUSH_MS = 60_000;

interface DayRec {
  day: string; // YYYY-MM-DD（服务器本地时区）
  ips: Set<string>;
  accounts: Set<string>;
  conns: number;
}

interface DauFile {
  days: { day: string; ips: string[]; accounts: string[]; conns: number }[];
}

export interface DauDaySummary {
  day: string;
  /** 当日去重来源 IP（同一 IP 多开/重连只计一次；CGNAT 下偏保守） */
  uv: number;
  /** 当日去重登录账号（匿名玩家不计） */
  accounts: number;
  /** 当日新建 WS 连接次数（含重连与刷新，反映活跃量而非人数） */
  conns: number;
}

let storePath: string | null = null;
let days: DayRec[] = []; // 升序
let dirty = false;

function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function currentDay(): DayRec {
  const d = today();
  let rec = days[days.length - 1];
  if (rec == null || rec.day !== d) {
    rec = { day: d, ips: new Set(), accounts: new Set(), conns: 0 };
    days.push(rec);
    if (days.length > KEEP_DAYS) days = days.slice(-KEEP_DAYS);
  }
  return rec;
}

function summarize(rec: DayRec): DauDaySummary {
  return { day: rec.day, uv: rec.ips.size, accounts: rec.accounts.size, conns: rec.conns };
}

/** 记一条新连接（须在配额校验通过后调用，脚本刷连接不进日活） */
export function recordConnection(ip: string): void {
  if (!ip) return;
  const rec = currentDay();
  rec.ips.add(ip);
  rec.conns += 1;
  dirty = true;
}

/** 记一次账号活跃（同一账号同日多次入房只计一次） */
export function recordAccountVisit(accountId: string): void {
  if (!accountId) return;
  currentDay().accounts.add(accountId);
  dirty = true;
}

function flush(): void {
  if (!dirty || !storePath) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const file: DauFile = {
      days: days.map((d) => ({ day: d.day, ips: [...d.ips], accounts: [...d.accounts], conns: d.conns })),
    };
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, storePath);
  } catch (e) {
    dirty = true; // 写失败保持脏标记，下一轮重试（内存数据不受影响）
    console.error('[dau] 日活数据落盘失败:', e);
  }
}

/** 启动时调用：加载历史快照并启动周期落盘；不调用（测试）则纯内存 */
export function initDauStore(filePath: string): void {
  storePath = filePath;
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DauFile;
      if (Array.isArray(parsed?.days)) {
        days = parsed.days
          .filter((d) => typeof d?.day === 'string' && Array.isArray(d.ips) && Array.isArray(d.accounts))
          .map((d) => ({
            day: d.day,
            ips: new Set(d.ips.filter((x) => typeof x === 'string')),
            accounts: new Set(d.accounts.filter((x) => typeof x === 'string')),
            conns: typeof d.conns === 'number' ? d.conns : 0,
          }));
      }
    }
  } catch (e) {
    console.error('[dau] 日活数据加载失败（仅内存）:', e);
  }
  if (days.length > KEEP_DAYS) days = days.slice(-KEEP_DAYS);
  setInterval(flush, FLUSH_MS).unref();
}

/** 管理端汇总：最近 lastN 天（含今天，新→旧） */
export function dauSummary(lastN = 30): DauDaySummary[] {
  currentDay(); // 确保今天有条目（哪怕还是零）
  return days.slice(-lastN).map(summarize).reverse();
}

/** 测试钩子：立即落盘一次（绕过 60s 周期） */
export function flushDauForTest(): void {
  flush();
}
