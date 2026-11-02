/**
 * 房间对局记录弹窗 · 组件测试（jsdom）：钉住交互口径——
 * 1. 打开即发 roomMatchHistory 请求；快照到达前显示「加载中」，未连接显示离线提示；
 * 2. 心有灵犀条目渲染完整轮次对照（左右两侧玩家名 + 相遇轮 cv-same 高亮）；
 * 3. 其他模式渲染服务端拼好的名次行（胜者 winner 高亮）；空快照显示空态；关闭按钮回调。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { RoomHistoryModal } from '../../src/components/RoomHistoryModal';
import { net } from '../../src/net/socket';
import type { RoomMatchEntry } from '@shared/protocol';

const T = new Date(2026, 10, 2, 12).getTime();

const CONVERGE_ENTRY: RoomMatchEntry = {
  mode: 'converge',
  startedAt: T - 120_000,
  endedAt: T,
  durationMin: 2,
  seatCount: 2,
  title: '心有灵犀 · 用 2 轮相遇「６」',
  ranks: [
    { seat: 0, name: '天梯体验员', text: '相遇 🧠' },
    { seat: 1, name: '月伴', text: '相遇 🧠' },
  ],
  converge: {
    result: { matched: true, rounds: 2, word: '６', reason: 'match' },
    rounds: [
      { n: 1, same: false, entries: [{ seat: 0, text: '大餐' }, { seat: 1, text: '肥牛卷' }] },
      { n: 2, same: true, entries: [{ seat: 0, text: '６' }, { seat: 1, text: '6' }] },
    ],
  },
};

const MINES_ENTRY: RoomMatchEntry = {
  mode: 'mines',
  startedAt: T - 300_000,
  endedAt: T - 200_000,
  seatCount: 2,
  title: '扫雷竞速 · 初级',
  winnerSeat: 1,
  ranks: [
    { seat: 1, name: '月伴', text: '通关 · 已揭 71 格' },
    { seat: 0, name: '天梯体验员', text: '出局 · 已揭 12 格' },
  ],
};

/** 桩住 net：捕获快照回调，send 返回指定连接态 */
function stubNet(connected = true) {
  let deliver: ((e: RoomMatchEntry[]) => void) | null = null;
  const sendSpy = vi.spyOn(net, 'send').mockReturnValue(connected);
  vi.spyOn(net, 'onRoomMatchLog').mockImplementation((l) => {
    deliver = l;
    return () => {
      deliver = null;
    };
  });
  return { sendSpy, push: (e: RoomMatchEntry[]) => act(() => deliver?.(e)) };
}

describe('RoomHistoryModal · 房间对局记录', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('打开即请求快照；到达前显示加载中；心有灵犀条目渲染完整轮次对照', () => {
    const { sendSpy, push } = stubNet();
    const { container } = render(<RoomHistoryModal onClose={() => {}} />);
    expect(sendSpy).toHaveBeenCalledWith({ t: 'roomMatchHistory' });
    expect(screen.getByText('加载中…')).toBeTruthy();

    push([CONVERGE_ENTRY, MINES_ENTRY]);
    expect(screen.queryByText('加载中…')).toBeNull();
    expect(screen.getByText('心有灵犀 · 用 2 轮相遇「６」')).toBeTruthy();
    // 左右两侧是谁
    expect(container.querySelector('.rh-cv-names')?.textContent).toContain('天梯体验员（左）');
    expect(container.querySelector('.rh-cv-names')?.textContent).toContain('月伴（右）');
    const rows = container.querySelectorAll('.rh-cv .cv-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('大餐');
    expect(rows[0].textContent).toContain('肥牛卷');
    expect(rows[0].classList.contains('cv-same')).toBe(false);
    expect(rows[1].classList.contains('cv-same')).toBe(true); // 相遇轮金框
  });

  it('其他模式渲染名次行，胜者 winner 高亮', () => {
    const { push } = stubNet();
    const { container } = render(<RoomHistoryModal onClose={() => {}} />);
    push([MINES_ENTRY]);
    const ranks = container.querySelectorAll('.rh-ranks .result-row');
    expect(ranks).toHaveLength(2);
    expect(ranks[0].textContent).toContain('1. 月伴');
    expect(ranks[0].textContent).toContain('通关 · 已揭 71 格');
    expect(ranks[0].classList.contains('winner')).toBe(true);
    expect(ranks[1].classList.contains('winner')).toBe(false);
  });

  it('空快照显示空态；未连接显示离线提示；关闭按钮回调', () => {
    const { push } = stubNet();
    const onClose = vi.fn();
    const { unmount } = render(<RoomHistoryModal onClose={onClose} />);
    push([]);
    expect(screen.getByText(/本房间还没有打完的对局/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
    unmount();
    vi.restoreAllMocks();

    stubNet(false); // send 返回 false = 未连接
    render(<RoomHistoryModal onClose={() => {}} />);
    expect(screen.getByText(/未连接服务器/)).toBeTruthy();
    expect(screen.queryByText('加载中…')).toBeNull();
  });
});
