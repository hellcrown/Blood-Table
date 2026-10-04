/**
 * Room（房间等待页）组件测试（jsdom）。此前该页只有构建+人工判断，这里钉住两处回归过的问题：
 * 1. 「移除机器人」必须按服务端下发的 isBot 字段识别，不得用 🤖 昵称前缀启发式
 *    （人类可合法取 🤖 开头昵称，旧启发式会让房主的移除按钮永远打不中真机器人）；
 * 2. 目标票数输入失焦钳制到 8-30（非 0），与服务端/界面承诺同口径。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Room } from '../../src/pages/Room';
import { net } from '../../src/net/socket';
import type { SeatView, TableView } from '@shared/protocol';

const ME = 'u-me';

function seat(partial: Partial<SeatView> & { id: string; seat: number }): SeatView {
  return {
    name: partial.id,
    chips: 0,
    isHost: false,
    connected: true,
    isBot: false,
    sittingOut: false,
    inHand: false,
    folded: false,
    allIn: false,
    bet: 0,
    committed: 0,
    isButton: false,
    role: null,
    lastAction: null,
    hasCards: false,
    hole: null,
    handName: null,
    won: 0,
    ...partial,
  };
}

/** 最小合法 TableView（waiting 页只用这些字段，多余字段按类型要求补齐） */
function waitingView(players: SeatView[]): TableView {
  return {
    kind: 'classic',
    code: 'TEST',
    mode: 'blood',
    phase: 'waiting',
    handNumber: 0,
    maxPlayers: 4,
    settings: { sb: 5, bb: 10, startChips: 1000 },
    hostId: ME,
    charExpansion: false,
    expansion: false,
    targetTickets: 24,
    players,
    community: [],
    pot: 0,
    currentBet: 0,
    minRaiseTo: 0,
    toActSeat: null,
    deadline: null,
    log: [],
    result: null,
    final: null,
    serverTime: Date.now(),
  };
}

describe('Room · 房间等待页', () => {
  beforeEach(() => {
    net.playerId = ME;
  });
  afterEach(() => {
    net.playerId = null;
    vi.restoreAllMocks();
  });

  it('「移除机器人」按 isBot 字段锁定真机器人（🤖 昵称的人类不被误选）', async () => {
    const user = userEvent.setup();
    const sendSpy = vi.spyOn(net, 'send');
    const view = waitingView([
      seat({ id: ME, seat: 0, name: '房主', isHost: true }),
      seat({ id: 'u-bot', seat: 1, name: '小美', isBot: true }), // 真机器人：昵称不带 🤖
      seat({ id: 'u-troll', seat: 2, name: '🤖假人', isBot: false }), // 人类：🤖 开头昵称
    ]);
    render(<Room view={view} />);
    const btn = screen.getByRole('button', { name: '移除机器人' });
    await user.click(btn);
    // 旧启发式会选中座位 2（🤖 前缀、座位号更大）→ 服务端必然报「该座位没有机器人」
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ t: 'kickBot', seat: 1 }));
  });

  it('目标票数失焦钳制：3 → 8、50 → 30，与服务端/界面承诺同口径', async () => {
    const user = userEvent.setup();
    const sendSpy = vi.spyOn(net, 'send');
    const view = waitingView([seat({ id: ME, seat: 0, name: '房主', isHost: true })]);
    render(<Room view={view} />);
    const input = screen.getByTitle(/自定义胜利目标票数/).querySelector('input')!;
    await user.clear(input);
    await user.type(input, '3');
    fireEvent.blur(input);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ t: 'settings', targetTickets: 8 }));
    expect((input as HTMLInputElement).value).toBe('8');

    await user.clear(input);
    await user.type(input, '50');
    fireEvent.blur(input);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ t: 'settings', targetTickets: 30 }));
    expect((input as HTMLInputElement).value).toBe('30');
  });

  it('清空目标票数提交 0（按人数默认），不误发 8', async () => {
    const user = userEvent.setup();
    const sendSpy = vi.spyOn(net, 'send');
    const view = waitingView([seat({ id: ME, seat: 0, name: '房主', isHost: true })]);
    render(<Room view={view} />);
    const input = screen.getByTitle(/自定义胜利目标票数/).querySelector('input')!;
    await user.clear(input);
    fireEvent.blur(input);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ t: 'settings', targetTickets: 0 }));
    expect((input as HTMLInputElement).value).toBe('');
  });
});
