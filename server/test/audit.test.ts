/**
 * 操作审计回归测试：start→act→chat→end 落盘与按 key 加载、sameIp 标记（bot 不参与）、
 * 未开局消息丢弃、跨天文件清理（保留今天+昨天）、坏行跳过、未初始化降级。
 * 假时钟控制「今天」（文件按天命名）；每例 resetModules + tmpdir 隔离（audit 是模块级单例）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpdir = (): string => path.join(os.tmpdir(), `blood-audit-test-${Math.random().toString(36).slice(2)}`);
const at = (y: number, m: number, d: number, hh = 12): number => new Date(y, m - 1, d, hh, 0, 0).getTime();

async function fresh(dir: string | null) {
  vi.resetModules();
  const audit = await import('../src/audit');
  if (dir) audit.initAuditStore(dir);
  return audit;
}

describe('audit · 操作审计', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(2026, 10, 7));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('start→act→chat→end 落盘；索引含 sameIp（bot 不计）与终局摘要；按 key 加载完整时间线', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    const startedAt = at(2026, 10, 7, 10);
    audit.recordGameStart({
      room: 'ABCD',
      mode: 'blood',
      startedAt,
      settings: { targetTickets: 24 },
      players: [
        { seat: 0, name: '甲', accountId: 'acc-1', ip: '1.1.1.1' },
        { seat: 1, name: '乙', ip: '1.1.1.1' }, // 与甲同 IP
        { seat: 2, name: '🤖bot', bot: true, ip: '1.1.1.1' }, // bot 同 IP 不计入
      ],
    });
    const key = `ABCD:${startedAt}`;
    audit.recordAction({ key, ts: startedAt + 5000, seat: 0, name: '甲', t: 'bPlay', p: { cardIds: ['c1', 'c2', 'c3', 'c4', 'c5'] } });
    audit.recordAction({ key, ts: startedAt + 6000, seat: 1, name: '乙', t: 'bSteal', p: { seat: 0 } });
    audit.recordChat({ key, ts: startedAt + 7000, seat: -1, name: '观众', text: '精彩！' });
    audit.recordGameEnd({ key, endedAt: startedAt + 400_000, durationMin: 6.6, winnerSeat: 0, summary: { rank: 'done' }, log: [{ seq: 1 }] });

    expect(audit.findAudit('ABCD', startedAt)).toEqual({ key, sameIp: [0, 1] });
    expect(audit.findAudit('ABCD', startedAt + 1)).toBeNull(); // 开局时间不同 → 无关联

    const games = audit.listAuditGames();
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ key, room: 'ABCD', mode: 'blood', endedAt: startedAt + 400_000, durationMin: 6.6, winnerSeat: 0 });
    expect(games[0]!.sameIp).toEqual([0, 1]); // bot 座位 2 不参与同 IP 判定

    const detail = audit.loadAuditGame(key)!;
    expect(detail.start.startedAt).toBe(startedAt);
    expect(detail.acts).toHaveLength(3);
    expect(detail.acts.map((a) => a.t)).toEqual(['bPlay', 'bSteal', 'chat']);
    expect(detail.end?.summary).toEqual({ rank: 'done' });

    // 模拟重启：索引从文件重建（含 end 摘要）
    const audit2 = await fresh(dir);
    const rebuilt = audit2.listAuditGames();
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({ key, endedAt: startedAt + 400_000, sameIp: [0, 1] });
    expect(audit2.loadAuditGame(key)!.acts).toHaveLength(3);
  });

  it('未开局（索引未命中）的操作与聊天被丢弃', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    audit.recordAction({ key: 'ABCD:0', ts: 1, seat: 0, name: '甲', t: 'bPlay' });
    audit.recordChat({ key: 'ABCD:0', ts: 1, seat: 0, name: '甲', text: 'hi' });
    expect(audit.listAuditGames()).toHaveLength(0);
    expect(audit.loadAuditGame('ABCD:0')).toBeNull();
  });

  it('跨天清理：只保留今天+昨天两个文件，更旧文件连同索引一起消失', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    vi.setSystemTime(at(2026, 10, 5)); // 前天开局
    audit.recordGameStart({ room: 'OLD1', mode: 'blood', startedAt: at(2026, 10, 5), players: [{ seat: 0, name: '甲' }] });
    expect(fs.existsSync(path.join(dir, 'audit-20261005.jsonl'))).toBe(true);
    // 跳到后天（10-07）：保留 10-07+10-06，10-05 应被清理
    vi.setSystemTime(at(2026, 10, 7));
    const audit2 = await fresh(dir);
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('audit-'));
    expect(files).toEqual([]); // 当天文件懒创建：清理后尚无新写入
    expect(audit2.listAuditGames()).toHaveLength(0);
    expect(audit2.loadAuditGame('OLD1:' + at(2026, 10, 5))).toBeNull();
  });

  it('坏行跳过：合法行仍能建索引与加载', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    audit.recordGameStart({ room: 'GOOD', mode: 'classic', startedAt: at(2026, 10, 7, 9), players: [{ seat: 0, name: '甲' }] });
    // 手工追加坏行（半行 JSON）
    const file = path.join(dir, fs.readdirSync(dir)[0]!);
    fs.appendFileSync(file, '{"k":"act","key":"GOOD:');
    const audit2 = await fresh(dir);
    expect(audit2.listAuditGames()).toHaveLength(1);
    expect(audit2.loadAuditGame(`GOOD:${at(2026, 10, 7, 9)}`)!.start.room).toBe('GOOD');
  });

  it('未初始化存储时全部 no-op（测试/降级口径）', async () => {
    const audit = await fresh(null);
    audit.recordGameStart({ room: 'X', mode: 'blood', startedAt: 1, players: [{ seat: 0, name: '甲' }] });
    audit.recordAction({ key: 'X:1', ts: 1, seat: 0, name: '甲', t: 'bPlay' });
    audit.recordChat({ key: 'X:1', ts: 1, seat: 0, name: '甲', text: 'hi' });
    audit.recordGameEnd({ key: 'X:1', endedAt: 2, summary: {} });
    expect(audit.listAuditGames()).toHaveLength(0);
  });
});
