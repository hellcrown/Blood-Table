/**
 * 个人战绩弹窗 · 组件测试（jsdom）：钉住全模式口径——
 * 1. /api/auth/me 的 recent 五种模式都渲染：模式名不再误显示成「德州」；
 * 2. 详情列按模式取数：血色=角色+车票、德州=筹码、扫雷=通关/出局+已揭格数、猎场=存活HP/阵亡、灵犀=相遇/未相遇；
 * 3. 跨模式聚合行（局数/夺冠/平均名次）照服务端口径展示。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MyStatsModal } from '../../src/components/MyStatsModal';
import { net } from '../../src/net/socket';

const T = new Date(2026, 10, 7, 12).getTime();

const RECENT = [
  { endedAt: T, mode: 'converge', seatCount: 2, rank: 2, matched: false, durationMin: 3 },
  { endedAt: T - 60_000, mode: 'converge', seatCount: 2, rank: 1, matched: true },
  { endedAt: T - 120_000, mode: 'tactics', seatCount: 2, rank: 2, hp: 0, alive: false },
  { endedAt: T - 180_000, mode: 'mines', seatCount: 2, rank: 1, revealed: 71, status: 'done' },
  { endedAt: T - 240_000, mode: 'mines', seatCount: 2, rank: 2, revealed: 12, status: 'out' },
  { endedAt: T - 300_000, mode: 'blood', seatCount: 3, rank: 1, charId: 'dealer', tickets: 24 },
  { endedAt: T - 360_000, mode: 'classic', seatCount: 4, rank: 3, chips: 500 },
  { endedAt: T - 420_000, mode: 'draw', seatCount: 3, rank: 1, score: 250 },
];

const ME = {
  ok: true,
  account: { id: 'acct-1', name: '天梯体验员' },
  ladder: { points: 42, wins: 3 },
  stats: { games: 7, wins: 4, avgRank: 1.4, chars: [{ charId: 'dealer', games: 1, wins: 1, winRate: 100, avgRank: 1 }], recent: RECENT },
};

function stubMe(payload: object) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
      }),
    ),
  );
  net.authToken = 'tok-test';
}

describe('MyStatsModal · 个人战绩全模式', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    net.authToken = '';
  });

  it('五种模式的模式名与详情列各自正确，新模式不再显示成「德州」', async () => {
    stubMe(ME);
    const { container } = render(<MyStatsModal onClose={() => {}} />);
    expect(await screen.findByText(/天梯体验员 的战绩/)).toBeTruthy();
    // 第 1 张表是常用角色，第 2 张才是最近对局
    const rows = container.querySelectorAll('.admin-table')[1].querySelectorAll('tbody tr');
    expect(rows).toHaveLength(8);
    const cell = (i: number, c: number): string => rows[i].querySelectorAll('td')[c].textContent ?? '';
    // 模式列（1）
    expect(cell(0, 1)).toBe('灵犀');
    expect(cell(2, 1)).toBe('猎场');
    expect(cell(3, 1)).toBe('扫雷');
    expect(cell(5, 1)).toBe('血色');
    expect(cell(6, 1)).toBe('德州');
    expect(cell(7, 1)).toBe('你画');
    // 详情列（4）
    expect(cell(0, 4)).toBe('未相遇');
    expect(cell(1, 4)).toBe('相遇 🧠');
    expect(cell(2, 4)).toBe('阵亡'); // 猎场 alive:false
    expect(cell(3, 4)).toContain('通关');
    expect(cell(3, 4)).toContain('已揭 71 格');
    expect(cell(4, 4)).toContain('出局 · 已揭 12 格');
    expect(cell(5, 4)).toContain('赌场荷官'); // 血色角色名（BLOOD_CHAR_BY_ID）
    expect(cell(5, 4)).toContain('24🎫');
    expect(cell(6, 4)).toContain('500 筹码');
    expect(cell(7, 4)).toBe('250 分'); // 你画我猜：总分
    // 名次列奖牌标记（rank 1/2/3 → 🥇🥈🥉）
    expect(cell(2, 3)).toBe('🥈');
    expect(cell(3, 3)).toBe('🥇');
  });

  it('聚合行与未相遇口径：局数/夺冠/平均名次照服务端统计展示', async () => {
    stubMe(ME);
    render(<MyStatsModal onClose={() => {}} />);
    expect(await screen.findByText(/共 7 局 · 夺冠 4 次（57.1%）· 平均名次 1.4/)).toBeTruthy();
    expect(screen.getByText(/⭐ 天梯 42 分 · 3 个计分胜场/)).toBeTruthy();
  });

  it('未登录提示与关闭回调', async () => {
    const onClose = vi.fn();
    net.authToken = '';
    render(<MyStatsModal onClose={onClose} />);
    expect(await screen.findByText('未登录')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
  });
});
