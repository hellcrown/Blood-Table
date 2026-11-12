import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoAction, applyAction, createGame, startHand } from '../src/game/engine';
import { bloodTick, createBloodGame } from '../src/blood/engine';
import { verifyRoomPassword } from '../src/rooms';

const NOW = 1000;

describe('房间密码校验', () => {
  it('无密码房间恒通过', () => {
    expect(verifyRoomPassword({}, 'abc')).toBeNull();
    expect(verifyRoomPassword({}, undefined)).toBeNull();
  });
  it('密码正确通过，错误/缺失/非字符串均拒绝', () => {
    const room = { password: '秘密123' };
    expect(verifyRoomPassword(room, '秘密123')).toBeNull();
    expect(verifyRoomPassword(room, '错误密码')).toBe('WRONG_PASSWORD');
    expect(verifyRoomPassword(room, undefined)).toBe('WRONG_PASSWORD');
    expect(verifyRoomPassword(room, 42)).toBe('WRONG_PASSWORD');
  });
});

describe('超时托管标记 wasAuto（血色）', () => {
  it('选将超时自动选将并标记；德州超时让牌同理', () => {
    const gs = createBloodGame(2, [{ id: 'p0', name: '甲', seat: 0 }, { id: 'p1', name: '乙', seat: 1 }], NOW);
    expect(gs.phase).toBe('pick');
    // 超时触发托管：自动选第一张
    bloodTick(gs, NOW + 61_000);
    expect(gs.players.every((p) => p.charId != null)).toBe(true);
    expect(gs.players.every((p) => p.wasAuto === true)).toBe(true);
  });
});

describe('超时托管标记 wasAuto（德州）', () => {
  function make2(): ReturnType<typeof createGame> {
    const players = [
      { id: 'a', name: '甲', seat: 0, chips: 1000 },
      { id: 'b', name: '乙', seat: 1, chips: 1000 },
    ];
    return createGame({ sb: 5, bb: 10, startChips: 1000 }, 2, players);
  }

  it('超时让牌标记 wasAuto，该玩家再次真人行动后清除', () => {
    const gs = make2();
    startHand(gs, NOW);
    const bbSeat = gs.bbSeat!;
    // 小盲补齐 → 轮到大盲（可过牌）
    applyAction(gs, gs.toActSeat!, { k: 'call' }, NOW + 1000);
    expect(gs.toActSeat).toBe(bbSeat);
    // 大盲超时：自动让牌并标记
    autoAction(gs, bbSeat, NOW + 61_000);
    expect(gs.players.find((p) => p.seat === bbSeat)!.wasAuto).toBe(true);
    // 翻牌后 heads-up 由非按钮位（大盲）先行动：亲自过牌 → 标记清除
    expect(gs.toActSeat).toBe(bbSeat);
    applyAction(gs, bbSeat, { k: 'check' }, NOW + 62_000);
    expect(gs.players.find((p) => p.seat === bbSeat)!.wasAuto).toBe(false);
    applyAction(gs, gs.toActSeat!, { k: 'check' }, NOW + 63_000);
  });
});

describe('对局记录落库 matchlog', () => {
  it('写入/恢复/统计聚合/清空 全链路', async () => {
    const { initMatchStore, recordMatch, listMatches, matchStats, clearMatches } = await import('../src/matchlog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchlog-'));
    const file = path.join(dir, 'matches.jsonl');
    initMatchStore(file);

    const base = {
      endedAt: Date.now(),
      durationMin: 12.5,
      seatCount: 2,
      winnerSeat: 0,
    };
    recordMatch({
      ...base,
      mode: 'blood',
      room: 'ABCD',
      startedAt: base.endedAt - 400_000,
      settings: { targetTickets: 24, charExpansion: false, expansion: false },
      players: [
        { name: '甲', seat: 0, rank: 1, charId: 'dealer', tickets: 24, blood: 30, wasAuto: false },
        { name: '机器人1', seat: 1, rank: 2, charId: 'clerk', tickets: 10, blood: 5, isBot: true, wasAuto: true },
      ],
    });
    recordMatch({
      ...base,
      mode: 'classic',
      settings: { sb: 5, bb: 10, startChips: 1000 },
      players: [
        { name: '乙', seat: 0, rank: 1, chips: 1500 },
        { name: '丙', seat: 1, rank: 2, chips: 0 },
      ],
    });
    // 新模式落库（扫雷/猎场/灵犀）：管理端统计与重启恢复都要认
    recordMatch({
      ...base,
      mode: 'mines',
      winnerSeat: 0,
      settings: { difficulty: 'medium' },
      players: [
        { name: '乙', seat: 0, rank: 1, revealed: 30, status: 'done', isBot: true },
        { name: '丙', seat: 1, rank: 2, revealed: 12, status: 'out' },
      ],
    });
    recordMatch({
      ...base,
      mode: 'tactics',
      winnerSeat: 1,
      settings: { mapSize: 'small' },
      players: [
        { name: '乙', seat: 0, rank: 2, hp: 0, alive: false },
        { name: '丙', seat: 1, rank: 1, hp: 7, alive: true },
      ],
    });
    recordMatch({
      ...base,
      mode: 'converge',
      winnerSeat: -1, // 灵犀无胜负概念
      converge: { matched: true, rounds: 3, word: '午睡', reason: 'match' },
      players: [
        { name: '乙', seat: 0, rank: 1 }, // 相遇双方并列 rank=1
        { name: '丙', seat: 1, rank: 1 },
      ],
    });

    // room/startedAt 往返：管理端「详情」入口靠它与审计关联
    expect(listMatches().some((m) => m.room === 'ABCD' && m.startedAt === base.endedAt - 400_000)).toBe(true);

    const stats = matchStats();
    expect(stats.total).toBe(5);
    expect(stats.byMode.blood).toBe(1);
    expect(stats.byMode.classic).toBe(1);
    expect(stats.byMode.mines).toBe(1);
    expect(stats.byMode.tactics).toBe(1);
    expect(stats.byMode.converge).toBe(1);
    expect(stats.avgDurationMin).toBe(12.5); // 新模式条目不带 durationMin，不掺入均值
    expect(stats.botShare).toBe(20); // 10 座位中 2 bot（血色机器人1 + 扫雷乙）
    const dealer = stats.chars.find((c) => c.charId === 'dealer');
    expect(dealer?.games).toBe(1);
    expect(dealer?.wins).toBe(1);
    expect(dealer?.winRate).toBe(100);
    expect(dealer?.avgRank).toBe(1);

    // 重启恢复：坏行跳过；新模式条目不得被重载守卫丢弃
    fs.appendFileSync(file, '这不是JSON\n');
    initMatchStore(file);
    expect(listMatches().length).toBe(5);
    expect(matchStats().total).toBe(5);
    expect(listMatches().filter((m) => m.mode === 'converge').length).toBe(1);

    clearMatches();
    expect(listMatches().length).toBe(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('角色胜率榜：minGames 过滤 + 胜率排序', async () => {
    const { initMatchStore, recordMatch, matchCharLeaderboard } = await import('../src/matchlog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchlog-lb-'));
    initMatchStore(path.join(dir, 'matches.jsonl'));

    // 一场 2 人血色局：seat 由参数指定名次
    const mk = (charId: string, rank: number, seat: number) => ({
      endedAt: Date.now(),
      mode: 'blood' as const,
      seatCount: 2,
      winnerSeat: rank === 1 ? seat : 1 - seat,
      players: [
        { name: '甲', seat, rank, charId },
        { name: '乙', seat: 1 - seat, rank: rank === 1 ? 2 : 1, charId: 'clerk' },
      ],
    });
    for (let i = 0; i < 6; i++) recordMatch({ ...mk('dealer', i % 2 === 0 ? 1 : 2, 0) }); // 6 局 3 冠 = 50%
    for (let i = 0; i < 5; i++) recordMatch({ ...mk('tarot', 1, 0) }); // 5 局 5 冠 = 100%
    for (let i = 0; i < 2; i++) recordMatch({ ...mk('miner', 1, 0) }); // 仅 2 局 → 过滤

    const board = matchCharLeaderboard(5);
    expect(board[0]?.charId).toBe('tarot');
    expect(board[0]?.winRate).toBe(100);
    expect(board[0]?.avgRank).toBe(1);
    const dealer = board.find((r) => r.charId === 'dealer');
    expect(dealer?.winRate).toBe(50);
    expect(dealer?.avgRank).toBe(1.5);
    expect(board.find((r) => r.charId === 'miner')).toBeUndefined();
    // clerk 陪跑 13 局（6+5+2 每场都有），仅在 dealer 落败的 3 局夺冠
    const clerk = board.find((r) => r.charId === 'clerk');
    expect(clerk?.games).toBe(13);
    expect(clerk?.wins).toBe(3);
    expect(clerk?.winRate).toBe(23.1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('个人战绩跨模式聚合：灵犀相遇=并列夺冠，recent 带各模式详情字段', async () => {
    const { initMatchStore, recordMatch, matchPlayerStats, clearMatches } = await import('../src/matchlog');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matchlog-stats-'));
    initMatchStore(path.join(dir, 'matches.jsonl'));
    const now = Date.now();
    // 同一账号 'acct-1' 打 5 种模式各一局（旧→新落库，recent 应新→旧）
    recordMatch({
      endedAt: now - 400_000,
      mode: 'blood',
      seatCount: 2,
      winnerSeat: 0,
      players: [
        { name: '甲', seat: 0, rank: 1, accountId: 'acct-1', charId: 'dealer', tickets: 24, blood: 30 },
        { name: '乙', seat: 1, rank: 2, charId: 'clerk', tickets: 9, blood: 4 },
      ],
    });
    recordMatch({
      endedAt: now - 300_000,
      mode: 'mines',
      seatCount: 2,
      winnerSeat: 0,
      settings: { difficulty: 'hard' },
      players: [
        { name: '甲', seat: 0, rank: 1, accountId: 'acct-1', revealed: 40, status: 'done' },
        { name: '乙', seat: 1, rank: 2, revealed: 5, status: 'out' },
      ],
    });
    recordMatch({
      endedAt: now - 200_000,
      mode: 'tactics',
      seatCount: 2,
      winnerSeat: 1,
      settings: { mapSize: 'medium' },
      players: [
        { name: '甲', seat: 0, rank: 2, accountId: 'acct-1', hp: 0, alive: false },
        { name: '乙', seat: 1, rank: 1, hp: 3, alive: true },
      ],
    });
    recordMatch({
      endedAt: now - 100_000,
      mode: 'converge',
      seatCount: 2,
      winnerSeat: -1,
      converge: { matched: true, rounds: 2, word: '６', reason: 'match' },
      players: [
        { name: '甲', seat: 0, rank: 1, accountId: 'acct-1' },
        { name: '乙', seat: 1, rank: 1 },
      ],
    });
    recordMatch({
      endedAt: now,
      mode: 'converge',
      seatCount: 2,
      winnerSeat: -1,
      converge: { matched: false, rounds: 3, reason: 'abort' },
      players: [
        { name: '甲', seat: 0, rank: 2, accountId: 'acct-1' },
        { name: '乙', seat: 1, rank: 2 },
      ],
    });

    const stats = matchPlayerStats('acct-1');
    expect(stats).not.toBeNull();
    // 血色冠 + 扫雷冠 + 灵犀相遇（并列冠）= 3 冠；灵犀未相遇 rank=2 不计冠
    expect(stats!.games).toBe(5);
    expect(stats!.wins).toBe(3);
    expect(stats!.avgRank).toBe(1.4); // (1+1+2+1+2)/5
    expect(stats!.chars).toHaveLength(1); // 角色表仍是血色专属
    expect(stats!.chars[0]?.charId).toBe('dealer');
    // recent 新→旧：灵犀未相遇在首，带 matched:false；各模式详情字段透传
    expect(stats!.recent.map((r) => r.mode)).toEqual(['converge', 'converge', 'tactics', 'mines', 'blood']);
    expect(stats!.recent[0]?.matched).toBe(false);
    expect(stats!.recent[1]?.matched).toBe(true);
    expect(stats!.recent[2]?.alive).toBe(false);
    expect(stats!.recent[3]?.status).toBe('done');
    expect(stats!.recent[4]?.tickets).toBe(24);
    // 无关账号不受新模式条目影响
    expect(matchPlayerStats('acct-2')).toBeNull();
    clearMatches();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('托管标记生命周期', () => {
  it('德州 startHand 重置 wasAuto（本手级标记，跨手/跨局不残留）', () => {
    const players = [
      { id: 'a', name: '甲', seat: 0, chips: 1000 },
      { id: 'b', name: '乙', seat: 1, chips: 1000 },
    ];
    const gs = createGame({ sb: 5, bb: 10, startChips: 1000 }, 2, players);
    // 上一手结束态残留标记（模拟终局后再来一场/下一手开始前）
    for (const p of gs.players) p.wasAuto = true;
    startHand(gs, NOW);
    expect(gs.players.every((p) => p.wasAuto === false)).toBe(true);
  });

  it('SlidingWindow.reached 只读检查不消耗额度', async () => {
    const { SlidingWindow } = await import('../src/net/limits');
    const w = new SlidingWindow(60_000, 2);
    expect(w.allow(1000)).toBe(true);
    expect(w.allow(1001)).toBe(true);
    expect(w.reached(1002)).toBe(true); // 已满
    expect(w.reached(1002)).toBe(true); // 只读，重复查询结果一致
    expect(w.allow(1003)).toBe(false); // allow 被拒
    expect(w.allow(70_000)).toBe(true); // 窗口滑过后恢复
  });
});
