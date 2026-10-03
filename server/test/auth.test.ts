import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountLadder,
  accountName,
  cleanAccountName,
  computeLadderPoints,
  initAuthRevocations,
  initAuthStore,
  isNameRegistered,
  issueToken,
  ladderBoard,
  login,
  recordLadderEvent,
  register,
  revokeToken,
  verifyToken,
  AUTH_TTL_MS,
} from '../src/auth';
import { initMatchStore, matchPlayerStats, recordMatch } from '../src/matchlog';

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `auth-${tag}-`));
}

describe('账号注册/登录', () => {
  const dir = tmpDir('reg');
  const users = path.join(dir, 'users.jsonl');
  const points = path.join(dir, 'points.jsonl');
  const secret = path.join(dir, 'auth-secret');

  beforeAll(() => initAuthStore(users, points, secret));

  it('注册成功并直接获得令牌；昵称清洗生效', () => {
    const r = register('  小明\u200b ', 'secret66');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.account.name).toBe('小明');
    expect(verifyToken(r.token)).toEqual({ accountId: r.account.accountId, name: '小明' });
  });

  it('昵称过短/密码过短拒绝；重名（含大小写折叠）拒绝', () => {
    expect(register('甲', 'secret66').ok).toBe(false); // 单字不放给注册（匿名仍可用）
    expect(register('正常昵称', '12345').ok).toBe(false); // 密码 <6
    expect(register('正常昵称', 'x'.repeat(33)).ok).toBe(false); // 密码 >32
    expect(register('小明', 'secret66').ok).toBe(false); // 精确重名
    expect(register('XIAOMING2', 'secret66').ok).toBe(true); // 不同昵称正常注册
    expect(register('xiaoming2', 'secret66').ok).toBe(false); // 小写索引折叠：视为同一昵称
  });

  it('登录：正确密码通过，错误密码/未知昵称拒绝且错误码一致（防枚举）', () => {
    const ok = login('小明', 'secret66');
    expect(ok.ok).toBe(true);
    const bad = login('小明', 'wrong!!');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('BAD_CREDENTIALS');
    const unknown = login('路人甲乙', 'whatever');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe('BAD_CREDENTIALS');
  });

  it('昵称保护查询与账号名回查', () => {
    expect(isNameRegistered('小明')).toBe(true);
    expect(isNameRegistered('  小明 ')).toBe(true); // 清洗后匹配
    expect(isNameRegistered('无名氏')).toBe(false);
    const r = register('查询用名', 'secret66');
    if (!r.ok) throw new Error('register failed');
    expect(accountName(r.account.accountId)).toBe('查询用名');
  });

  it('重启恢复：users/points/secret 全部从文件还原，旧令牌仍有效', () => {
    const r = register('持久化玩家', 'secret66');
    if (!r.ok) throw new Error('register failed');
    recordLadderEvent({
      accountId: r.account.accountId,
      ts: Date.now(),
      durationMin: 25,
      tickets: 30,
      secondTickets: 23,
      targetTickets: 24,
      seatCount: 3,
      points: 5,
    });
    // 模拟重启：重新 init 同一批文件
    initAuthStore(users, points, secret);
    expect(verifyToken(r.token)?.name).toBe('持久化玩家'); // HMAC 密钥持久化 → 令牌跨重启有效
    expect(accountLadder(r.account.accountId)).toEqual({ points: 5, wins: 1 });
    expect(isNameRegistered('持久化玩家')).toBe(true);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('登录令牌校验', () => {
  const dir = tmpDir('token');
  beforeAll(() => initAuthStore(path.join(dir, 'users.jsonl'), path.join(dir, 'points.jsonl'), path.join(dir, 'auth-secret')));

  it('过期令牌拒绝', () => {
    const r = register('过期测试', 'secret66');
    if (!r.ok) throw new Error('register failed');
    const expired = issueToken(r.account.accountId, -1000);
    expect(verifyToken(expired)).toBeNull();
    const fresh = issueToken(r.account.accountId, AUTH_TTL_MS);
    expect(verifyToken(fresh)?.accountId).toBe(r.account.accountId);
  });

  it('篡改载荷/HMAC、垃圾输入、未知账号均拒绝', () => {
    const r = register('篡改测试', 'secret66');
    if (!r.ok) throw new Error('register failed');
    const token = issueToken(r.account.accountId);
    const parts = token.split('.');
    // 篡改过期时间（载荷变化 → HMAC 不匹配）
    expect(verifyToken(`${parts[0]}.${parts[1]}.zzzzz.${parts[3]}`)).toBeNull();
    // 篡改 HMAC
    expect(verifyToken(`${parts[0]}.${parts[1]}.${parts[2]}.${'0'.repeat(64)}`)).toBeNull();
    // 垃圾输入
    expect(verifyToken('garbage')).toBeNull();
    expect(verifyToken(null)).toBeNull();
    expect(verifyToken(42)).toBeNull();
    // 未知账号（合法签名但账号不存在）
    expect(verifyToken(issueToken('deadbeefdeadbeef'))).toBeNull();
  });

  it('登出吊销：已吊销令牌立即失效；垃圾/伪造令牌吊销为 no-op；重启后黑名单仍生效', () => {
    const r = register('登出测试', 'secret66');
    if (!r.ok) throw new Error('register failed');
    const revFile = path.join(dir, 'auth-revoked.jsonl');
    initAuthRevocations(revFile); // 与生产一致：启动即初始化黑名单，此后吊销才落盘
    const token = issueToken(r.account.accountId);
    expect(verifyToken(token)?.accountId).toBe(r.account.accountId);
    revokeToken(token);
    expect(verifyToken(token)).toBeNull(); // 吊销后立即失效
    // 伪造/垃圾令牌：吊销 no-op，不污染黑名单
    const forged = `${'v1'}.${r.account.accountId}.${Date.now().toString(36)}.${'0'.repeat(64)}`;
    revokeToken(forged);
    revokeToken('garbage');
    revokeToken(null);
    expect(verifyToken(forged)).toBeNull(); // 本就无效（HMAC 不匹配）
    // 同账号重新登录的新令牌不受影响
    const again = login('登出测试', 'secret66');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(verifyToken(again.token)?.accountId).toBe(r.account.accountId);
    // 模拟重启：黑名单从文件恢复，已吊销令牌仍失效
    initAuthRevocations(revFile);
    expect(verifyToken(token)).toBeNull();
    expect(verifyToken(again.token)?.accountId).toBe(r.account.accountId);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('天梯积分公式 computeLadderPoints（三轴各 0~2，clamp 0~5）', () => {
  const TARGET = 24;
  const axis = (durationMin: number, tickets: number, secondTickets: number) =>
    computeLadderPoints(durationMin, tickets, secondTickets, TARGET);

  it('时长轴：<10 分钟 0 分，10~20 分钟 1 分，≥20 分钟 2 分', () => {
    // 固定另外两轴为 0：超出目标 0 票 → o=0；第二名距目标 6 → g=0
    expect(axis(9.9, 24, 18)).toBe(0);
    expect(axis(10, 24, 18)).toBe(1);
    expect(axis(19.9, 24, 18)).toBe(1);
    expect(axis(20, 24, 18)).toBe(2);
  });

  it('本人车票轴：超出目标 <2 → 0，2~4 → 1，≥5 → 2', () => {
    expect(axis(0, 25, 18)).toBe(0); // +1 → 0 分
    expect(axis(0, 26, 18)).toBe(1); // +2 → 1 分
    expect(axis(0, 28, 18)).toBe(1); // +4 → 1 分
    expect(axis(0, 29, 18)).toBe(2); // +5 → 2 分
  });

  it('竞争轴：第二名距目标 ≤1 → 2 分，2~4 → 1 分，≥5 → 0 分', () => {
    expect(axis(0, 24, 23)).toBe(2); // 差 1 票，险胜
    expect(axis(0, 24, 22)).toBe(1); // 差 2 票
    expect(axis(0, 24, 20)).toBe(1); // 差 4 票
    expect(axis(0, 24, 19)).toBe(0); // 差 5 票
  });

  it('三轴合计封顶 5 分；目标票数不同照样成立', () => {
    expect(computeLadderPoints(30, 40, 39, 30)).toBe(5); // 2+2+2 → clamp 5
    expect(computeLadderPoints(25, 26, 15, 24)).toBe(3); // 2+1+0
    expect(computeLadderPoints(0, 24, 24, 24)).toBe(2); // 极速贴身胜也有险胜分
  });
});

describe('天梯榜聚合与个人战绩', () => {
  const dir = tmpDir('ladder');
  const mdir = tmpDir('ladder-m');
  let A = '';
  let B = '';
  let C = '';

  beforeAll(() => {
    initAuthStore(path.join(dir, 'users.jsonl'), path.join(dir, 'points.jsonl'), path.join(dir, 'auth-secret'));
    initMatchStore(path.join(mdir, 'matches.jsonl'));
    const win = register('天梯选手', 'secret66');
    const win2 = register('并列选手', 'secret66');
    const loser = register('陪打玩家', 'secret66');
    if (!win.ok || !win2.ok || !loser.ok) throw new Error('register failed');
    A = win.account.accountId;
    B = win2.account.accountId;
    C = loser.account.accountId;

    recordLadderEvent({ accountId: A, ts: 1, durationMin: 20, tickets: 26, secondTickets: 22, targetTickets: 24, seatCount: 3, points: 3 });
    recordLadderEvent({ accountId: A, ts: 2, durationMin: 12, tickets: 24, secondTickets: 19, targetTickets: 24, seatCount: 2, points: 1 });
    recordLadderEvent({ accountId: B, ts: 3, durationMin: 30, tickets: 40, secondTickets: 39, targetTickets: 30, seatCount: 4, points: 5 });
    recordLadderEvent({ accountId: C, ts: 4, durationMin: 5, tickets: 24, secondTickets: 10, targetTickets: 24, seatCount: 2, points: 0 }); // 0 分胜局也计胜场
  });

  it('ladderBoard 按积分降序、并列按胜场；0 分胜局计入胜场', () => {
    const board = ladderBoard();
    expect(board[0]).toMatchObject({ accountId: B, name: '并列选手', points: 5, wins: 1 });
    expect(board[1]).toMatchObject({ accountId: A, points: 4, wins: 2 });
    const c = board.find((r) => r.accountId === C);
    expect(c).toMatchObject({ points: 0, wins: 1 });
  });

  it('个人战绩：按 accountId 聚合名次/角色/最近对局', () => {
    recordMatch({
      endedAt: 1000,
      durationMin: 20,
      mode: 'blood',
      seatCount: 3,
      winnerSeat: 0,
      players: [
        { name: '天梯选手', seat: 0, rank: 1, accountId: A, charId: 'dealer', tickets: 26, blood: 10 },
        { name: '陪打玩家', seat: 1, rank: 2, accountId: C, charId: 'clerk', tickets: 22, blood: 5 },
        { name: '机器人1', seat: 2, rank: 3, charId: 'miner', tickets: 9, isBot: true },
      ],
    });
    recordMatch({
      endedAt: 2000,
      mode: 'blood',
      seatCount: 2,
      winnerSeat: 1,
      players: [
        { name: '陪打玩家', seat: 1, rank: 1, accountId: C, charId: 'clerk', tickets: 24, blood: 3 },
        { name: '天梯选手', seat: 0, rank: 2, accountId: A, charId: 'tarot', tickets: 20, blood: 8 },
      ],
    });
    recordMatch({
      endedAt: 3000,
      mode: 'blood',
      seatCount: 2,
      winnerSeat: 1,
      players: [
        { name: '陪打玩家', seat: 1, rank: 1, accountId: C, charId: 'actor', tickets: 24, blood: 6 },
        { name: '天梯选手', seat: 0, rank: 2, accountId: A, charId: 'dealer', tickets: 18, blood: 2 },
      ],
    });

    const a = matchPlayerStats(A);
    expect(a).not.toBeNull();
    expect(a!.games).toBe(3);
    expect(a!.wins).toBe(1);
    expect(a!.avgRank).toBe(1.67); // (1+2+2)/3，保留两位
    expect(a!.chars.map((c) => c.charId)).toEqual(['dealer', 'tarot']); // dealer 出场 2 次 > tarot 1 次
    expect(a!.recent).toHaveLength(3);
    expect(a!.recent[0]!.endedAt).toBe(3000); // 新→旧

    const c = matchPlayerStats(C);
    expect(c!.games).toBe(3);
    expect(c!.wins).toBe(2);
    const clerk = c!.chars.find((x) => x.charId === 'clerk');
    expect(clerk).toMatchObject({ games: 2, wins: 1, winRate: 50, avgRank: 1.5 });

    expect(matchPlayerStats('nobody')).toBeNull(); // 无记录
  });

  it('同账号同局占多座：每行都计入个人战绩（不再漏计）', () => {
    recordMatch({
      endedAt: 4000,
      mode: 'blood',
      seatCount: 2,
      winnerSeat: 0,
      players: [
        { name: '双开甲', seat: 0, rank: 1, accountId: A, charId: 'clerk', tickets: 24, blood: 6 },
        { name: '双开甲#2', seat: 1, rank: 2, accountId: A, charId: 'clerk', tickets: 10, blood: 3 },
      ],
    });
    const a2 = matchPlayerStats(A);
    expect(a2!.games).toBe(5); // 3 局各 1 行 + 双开 1 局 2 行
    expect(a2!.wins).toBe(2);
  });

  it('昵称清洗与 rooms.cleanName 同口径', () => {
    expect(cleanAccountName('  a\u200bb  ')).toBe('ab'); // 零宽字符剔除
    expect(cleanAccountName(' a  b ')).toBe('a b'); // 连续空白折叠
    expect(cleanAccountName(42)).toBe('');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(mdir, { recursive: true, force: true });
  });
});
