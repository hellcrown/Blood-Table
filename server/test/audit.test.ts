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
    expect(audit2.findAudit('OLD1', at(2026, 10, 5))).toBeNull(); // 索引同口径淘汰（磁盘删了内存也不能留）
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

  it('rooms 采集点集成：auth/adminToken/name 裁剪、超长 p 截断、观战者 seat=-1、未开局丢弃', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    const { RoomManager } = await import('../src/rooms');
    const { BloodError } = await import('../src/blood/engine');
    const mgr = new RoomManager();
    const sent: unknown[] = [];
    const ws = { readyState: 1, OPEN: 1, send: (d: string) => sent.push(JSON.parse(d)), on: () => {}, close: () => {}, ip: '9.9.9.9' };
    const session = { id: 's0', token: 'tok', name: '甲', seat: -1, connected: true, ws, lastEventSeq: 0 } as never;
    const room = {
      code: 'TAP1', hostId: 's0', ownerIp: '', maxPlayers: 4, mode: 'blood',
      settings: {}, charExpansion: false, expansion: false, targetTickets: 0,
      sessions: new Map([['s0', session]]), chatLog: [], game: null, pendingRemove: new Set(),
      emptySince: 0, botBrains: new Map(), botNextAct: new Map(), matchLogged: true, gameStartedAt: undefined,
    } as never;
    const h = (mgr as unknown as { handleBlood: (r: never, s: never, m: unknown) => void }).handleBlood;
    // 未开局（gameStartedAt undefined）：操作尝试不落盘（引擎侧经 ws 回 NO_GAME，不抛错）
    h(room, session, { t: 'bSteal', seat: 0, auth: 'tok', adminToken: 'adm', name: 'hack' });
    expect(sent.some((x) => (x as { code?: string }).code === 'NO_GAME')).toBe(true);
    expect(audit.listAuditGames()).toHaveLength(0);
    // 开局（gameStartedAt 就位）：观战者（seat=-1）的尝试被记录，且 auth/adminToken/name 被裁剪、超长数组截断
    (room as { gameStartedAt?: number }).gameStartedAt = at(2026, 10, 7, 10);
    audit.recordGameStart({ room: 'TAP1', mode: 'blood', startedAt: at(2026, 10, 7, 10), players: [{ seat: 0, name: '甲' }] });
    const junk = 'x'.repeat(2000);
    h(room, session, { t: 'bSteal', seat: 0, auth: 'tok', adminToken: 'adm', name: 'hack', junk }); // 观战/无局：尝试仍被审计
    const key = `TAP1:${at(2026, 10, 7, 10)}`;
    const detail = audit.loadAuditGame(key)!;
    expect(detail.acts).toHaveLength(1);
    const line = JSON.stringify(detail.acts[0]);
    expect(line).not.toContain('tok');
    expect(line).not.toContain('adm');
    expect(line).not.toContain('"name":"hack"');
    expect(line).toContain('truncated'); // 2000 字符 junk 被截断
  });

  it('每局 act 行数上限：超限只计 dropped，end 行带 actsTruncated', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    const startedAt = at(2026, 10, 7, 10);
    audit.recordGameStart({ room: 'CAP1', mode: 'blood', startedAt, players: [{ seat: 0, name: '甲' }] });
    const key = `CAP1:${startedAt}`;
    for (let i = 0; i < 2005; i++) {
      audit.recordAction({ key, ts: startedAt + i, seat: 0, name: '甲', t: 'bPlay', p: { i } });
    }
    audit.recordGameEnd({ key, endedAt: startedAt + 500_000, winnerSeat: 0, summary: {} });
    const detail = audit.loadAuditGame(key)!;
    expect(detail.acts).toHaveLength(2000); // 上限封顶：精确 2000 行
    expect(detail.end?.actsTruncated).toBe(5);
  });

  it('resolvedOnly 双守卫：解散补写不得覆盖真实终局摘要', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    const startedAt = at(2026, 10, 7, 10);
    audit.recordGameStart({ room: 'FIN1', mode: 'blood', startedAt, players: [{ seat: 0, name: '甲' }] });
    const key = `FIN1:${startedAt}`;
    audit.recordAction({ key, ts: startedAt + 1000, seat: 0, name: '甲', t: 'bPlay', p: { cardIds: ['c1'] } });
    audit.recordGameEnd({ key, endedAt: startedAt + 400_000, durationMin: 6.6, winnerSeat: 0, summary: { real: true }, log: [{ seq: 1 }] });
    // 模拟 5 分钟空房回收对已终局对局的解散补写：必须被拒绝
    audit.recordGameEnd({ key, endedAt: startedAt + 500_000, summary: { resolved: false }, log: [], resolvedOnly: true });
    const detail = audit.loadAuditGame(key)!;
    expect(detail.end?.endedAt).toBe(startedAt + 400_000);
    expect(detail.end?.summary).toEqual({ real: true });
    expect(detail.end?.durationMin).toBe(6.6);
  });

  it('chat 行独立上限：超 CHAT_CAP 只计 dropped，end 行带 chatTruncated', async () => {
    const dir = tmpdir();
    const audit = await fresh(dir);
    const startedAt = at(2026, 10, 7, 10);
    audit.recordGameStart({ room: 'CHT1', mode: 'blood', startedAt, players: [{ seat: 0, name: '甲' }] });
    const key = `CHT1:${startedAt}`;
    for (let i = 0; i < 503; i++) {
      audit.recordChat({ key, ts: startedAt + i, seat: 0, name: '甲', text: `m${i}` });
    }
    audit.recordGameEnd({ key, endedAt: startedAt + 100_000, summary: {}, resolvedOnly: true });
    const detail = audit.loadAuditGame(key)!;
    expect(detail.acts.filter((a) => a.t === 'chat')).toHaveLength(500);
    expect(detail.end?.chatTruncated).toBe(3);
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
