/**
 * 点将卡：注册用户每日 3 局可指定本局角色（rooms.ts 在开局且指定真正生效时扣次）。
 * - 存储：data/dianjiang.json 单文件快照（照 dau 模式：脏后 60s 原子写回，保留最近 8 天）
 * - 配额按「服务器本地日期」重置；未 initDianjiangStore（测试/未调用）时纯内存可用
 * - 计数键为 accountId（昵称可改、id 稳定）；匿名玩家永远 0 次（rooms 层先验注册态）
 */
import fs from 'node:fs';
import path from 'node:path';

const DAILY_LIMIT = 3;
const KEEP_DAYS = 8;
const FLUSH_MS = 60_000;

interface DayRec {
  day: string;
  /** accountId → 当日已用次数 */
  uses: Map<string, number>;
}

interface DianjiangFile {
  days: { day: string; uses: Record<string, number> }[];
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
    rec = { day: d, uses: new Map() };
    days.push(rec);
    if (days.length > KEEP_DAYS) days = days.slice(-KEEP_DAYS);
  }
  return rec;
}

/** 该账号今日剩余点将次数 */
export function dianjiangRemaining(accountId: string): number {
  if (!accountId) return 0;
  const rec = days.find((d) => d.day === today());
  return DAILY_LIMIT - (rec?.uses.get(accountId) ?? 0);
}

/** 记一次使用（开局且指定生效时调用；调用方保证未超限） */
export function recordDianjiangUse(accountId: string): void {
  if (!accountId) return;
  const rec = currentDay();
  rec.uses.set(accountId, (rec.uses.get(accountId) ?? 0) + 1);
  dirty = true;
}

function flush(): void {
  if (!dirty || !storePath) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const file: DianjiangFile = {
      days: days.map((d) => ({ day: d.day, uses: Object.fromEntries(d.uses) })),
    };
    const tmp = `${storePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, storePath);
  } catch (e) {
    dirty = true; // 写失败保持脏标记，下一轮重试
    console.error('[dianjiang] 点将卡数据落盘失败:', e);
  }
}

/** 启动时调用：加载快照并周期落盘；不调用则纯内存 */
export function initDianjiangStore(filePath: string): void {
  storePath = filePath;
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as DianjiangFile;
      if (Array.isArray(parsed?.days)) {
        days = parsed.days
          .filter((d) => typeof d?.day === 'string' && d.uses != null && typeof d.uses === 'object')
          .map((d) => ({
            day: d.day,
            uses: new Map(
              Object.entries(d.uses)
                .filter(([, n]) => typeof n === 'number' && n > 0)
                .map(([k, n]) => [k, Math.min(Math.floor(n), DAILY_LIMIT)]), // 钳制：损坏数据不得让剩余次数为负
            ),
          }));
      }
    }
  } catch (e) {
    // 损坏文件改存 .bak 抢救，而不是等下一次 flush 被空数据覆盖
    try {
      fs.renameSync(filePath, `${filePath}.bak`);
      console.error('[dianjiang] 原快照已改存 .bak:', e);
    } catch {
      console.error('[dianjiang] 点将卡数据加载失败且备份失败（仅内存）:', e);
    }
  }
  if (days.length > KEEP_DAYS) days = days.slice(-KEEP_DAYS);
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  setInterval(flush, FLUSH_MS).unref();
}

/** 测试钩子：立即落盘（绕过 60s 周期） */
export function flushDianjiang(): void {
  flush();
}
