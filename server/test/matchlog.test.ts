import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoAction, applyAction, createGame, startHand } from '../src/game/engine';
import { bloodTick, bCrownBid, createBloodGame as createBloodGameRaw } from '../src/blood/engine';
import { verifyRoomPassword } from '../src/rooms';
import type { BloodState } from '../src/blood/types';

const NOW = 1000;

/** 开局特权证暗标辅助：全员出价 1 并结算（平局掷骰），保持旧测试「建局即选将」语义 */
function createBloodGame(...args: Parameters<typeof createBloodGameRaw>): BloodState {
  const gs = createBloodGameRaw(...args);
  for (const p of gs.players) bCrownBid(gs, p.id, 1, NOW);
  return gs;
}

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

    const stats = matchStats();
    expect(stats.total).toBe(2);
    expect(stats.byMode.blood).toBe(1);
    expect(stats.byMode.classic).toBe(1);
    expect(stats.avgDurationMin).toBe(12.5);
    expect(stats.botShare).toBe(25); // 4 座位中 1 bot
    const dealer = stats.chars.find((c) => c.charId === 'dealer');
    expect(dealer?.games).toBe(1);
    expect(dealer?.wins).toBe(1);
    expect(dealer?.winRate).toBe(100);
    expect(dealer?.avgRank).toBe(1);

    // 重启恢复：坏行跳过
    fs.appendFileSync(file, '这不是JSON\n');
    initMatchStore(file);
    expect(listMatches().length).toBe(2);
    expect(matchStats().total).toBe(2);

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
