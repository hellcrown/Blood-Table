/**
 * 你画我猜 · 对局页组件测试（jsdom；画布用记录调用的假 2D 上下文——jsdom 没有 canvas 实现）
 * 钉住：三种身份的视图（画手/猜词者/观战）、选词卡、猜词发送与输入法守卫、指针作画按批发送、
 * 撤销、远端快照到达即重绘、揭晓横幅、终局排名与再来一局。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { DrawView } from '@shared/drawProtocol';
import { DrawTable } from '../../src/pages/DrawTable';
import { net, type DrawEvent } from '../../src/net/socket';

vi.mock('../../src/audio/sound', () => ({ playSfx: vi.fn() }));

const ME = 'u-me';
const T0 = 1_700_000_000_000;

function dView(overrides?: Partial<DrawView>): DrawView {
  return {
    kind: 'draw',
    mode: 'draw',
    code: 'TEST',
    hostId: ME,
    phase: 'drawing',
    players: [
      { id: ME, name: '我', seat: 0, score: 0, left: false, connected: true, solved: false, gained: 0 },
      { id: 'u2', name: '对手', seat: 1, score: 0, left: false, connected: true, solved: false, gained: 0 },
    ],
    turnId: 0,
    drawRev: 1,
    turnNo: 1,
    totalTurns: 4,
    cycles: 2,
    turnSec: 80,
    drawerId: 'u2',
    choices: null,
    word: null,
    hint: '＿＿＿',
    wordLen: 3,
    category: '动作',
    difficulty: 3,
    deadline: T0 + 60_000,
    serverTime: T0,
    endReason: null,
    feed: [],
    iSolved: false,
    spectator: false,
    ranking: [],
    result: null,
    startedAt: T0,
    log: [],
    logSeq: 0,
    ...overrides,
  };
}

/** 假 2D 上下文：记录绘制指令 */
let calls: string[] = [];
function installCanvasStub(): () => void {
  calls = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    setTransform: () => calls.push('setTransform'),
    fillRect: () => calls.push('fillRect'),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    stroke: () => calls.push('stroke'),
    arc: () => calls.push('arc'),
    fill: () => calls.push('fill'),
  };
  const orig = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => ctx,
  });
  return () => {
    if (orig) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', orig);
  };
}

const rect = { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) };

describe('DrawTable · 你画我猜对局页', () => {
  let restoreCanvas: () => void = () => {};
  beforeEach(() => {
    net.playerId = ME;
    net.status = 'open';
    net.drawBoard.replace(0, 1, []);
    restoreCanvas = installCanvasStub();
  });
  afterEach(() => {
    restoreCanvas();
    net.playerId = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('猜词者：看掩码提示与类别、看不到答案；回车发 dGuess 并清空；输入法组合中的回车不发送', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    render(<DrawTable view={dView()} />);
    expect(screen.getByText('＿＿＿')).toBeTruthy();
    expect(screen.getByText(/3 字 · 动作 · 困难/)).toBeTruthy();
    const input = screen.getByPlaceholderText('输入你的猜测，回车发送') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '打喷嚏' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(sendSpy).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sendSpy).toHaveBeenCalledWith({ t: 'dGuess', text: '打喷嚏' });
    expect(input.value).toBe('');
    expect(screen.queryByRole('button', { name: '🧽 橡皮' })).toBeNull(); // 猜词者没有工具栏
  });

  it('画手：看到答案与倍率、工具栏（画笔/橡皮双按钮、色块、粗细）；输入框禁用', () => {
    render(<DrawTable view={dView({ drawerId: ME, word: '打喷嚏', hint: null })} />);
    expect(screen.getByText('打喷嚏')).toBeTruthy();
    expect(screen.getByText(/困难 ×2/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '✏️ 画笔' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '🧽 橡皮' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '红' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '粗笔' })).toBeTruthy();
    const input = screen.getByPlaceholderText('你是画手，专心画吧') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('选词：画手看三张词卡（难度×倍率），点击发 dPick；猜词者只见「正在选词」', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    const choices = [
      { word: '猫', cat: '动物', d: 1 as const },
      { word: '恐龙', cat: '动物', d: 2 as const },
      { word: '打喷嚏', cat: '动作', d: 3 as const },
    ];
    const { unmount } = render(
      <DrawTable view={dView({ phase: 'choosing', drawerId: ME, choices, word: null, hint: null, wordLen: 0, category: null, difficulty: null })} />,
    );
    expect(screen.getByText('选一个词来画')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /恐龙/ }));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'dPick', index: 1 });
    expect(screen.getByText(/中等 ×1.5/)).toBeTruthy();
    unmount();
    render(<DrawTable view={dView({ phase: 'choosing', word: null, hint: null, wordLen: 0, category: null, difficulty: null })} />);
    expect(screen.getAllByText(/对手 正在选词/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /恐龙/ })).toBeNull();
  });

  it('指针作画：落笔与续点攒成一批，100ms 节拍发 dStroke；撤销立即发送', () => {
    vi.useFakeTimers();
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    const { container } = render(<DrawTable view={dView({ drawerId: ME, word: '猫', hint: null, difficulty: 1 })} />);
    const canvas = container.querySelector('canvas.dr-canvas') as HTMLCanvasElement;
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => rect });
    fireEvent.pointerDown(canvas, { clientX: 200, clientY: 150, pointerId: 1, button: 0, pointerType: 'mouse' });
    fireEvent.pointerMove(canvas, { clientX: 240, clientY: 150, pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerMove(canvas, { clientX: 280, clientY: 150, pointerId: 1, pointerType: 'mouse' });
    expect(sendSpy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(sendSpy).toHaveBeenCalledWith({
      t: 'dStroke',
      ops: [{ k: 'b', id: 0, c: 1, w: 1, p: [500, 375, 600, 375, 700, 375] }],
    });
    expect(calls).toContain('lineTo'); // 本地立即画出
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('button', { name: '↶ 撤销' }));
    expect(sendSpy).toHaveBeenLastCalledWith({ t: 'dStroke', ops: [{ k: 'u' }] });
  });

  it('非画手不能落笔：pointer 事件不产生任何发送', () => {
    vi.useFakeTimers();
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    const { container } = render(<DrawTable view={dView()} />);
    const canvas = container.querySelector('canvas.dr-canvas') as HTMLCanvasElement;
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => rect });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1, button: 0, pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('远端快照到达：整幅重绘（先铺画纸再逐笔画）', () => {
    let deliver: ((e: DrawEvent) => void) | null = null;
    vi.spyOn(net, 'onDraw').mockImplementation((l) => {
      deliver = l;
      return () => {
        deliver = null;
      };
    });
    render(<DrawTable view={dView()} />);
    calls = [];
    net.drawBoard.replace(0, 5, [{ id: 0, c: 2, w: 1, p: [0, 0, 500, 375] }]);
    act(() => deliver?.({ kind: 'snap' }));
    expect(calls.slice(0, 2)).toEqual(['setTransform', 'fillRect']);
    expect(calls).toContain('lineTo');
  });

  it('揭晓：画布顶部横幅显示答案、结束原因与本回合得分', () => {
    render(
      <DrawTable
        view={dView({
          phase: 'reveal',
          word: '打喷嚏',
          hint: null,
          endReason: 'all',
          players: [
            { id: ME, name: '我', seat: 0, score: 200, left: false, connected: true, solved: true, gained: 200 },
            { id: 'u2', name: '对手', seat: 1, score: 50, left: false, connected: true, solved: false, gained: 50 },
          ],
        })}
      />,
    );
    expect(screen.getByText(/全员猜对/)).toBeTruthy();
    expect(screen.getByText('我 +200')).toBeTruthy();
    expect(screen.getByText('对手 +50')).toBeTruthy();
  });

  it('终局：排名（同分并列）+ 房主再来一局发 dRematch；观战者无输入框', () => {
    const sendSpy = vi.spyOn(net, 'send').mockReturnValue(true);
    const over = dView({
      phase: 'gameover',
      deadline: null,
      result: { reason: 'done', turns: 4 },
      ranking: [
        { seat: 0, name: '我', score: 300, rank: 1, left: false },
        { seat: 1, name: '对手', score: 120, rank: 2, left: false },
      ],
    });
    const { unmount } = render(<DrawTable view={over} />);
    expect(screen.getByText('全部回合画完')).toBeTruthy();
    expect(screen.getByText(/👑/).textContent).toContain('我');
    fireEvent.click(screen.getByRole('button', { name: '再来一局' }));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'dRematch' });
    unmount();
    const { container } = render(<DrawTable view={dView({ spectator: true, players: dView().players.slice(1) })} />);
    expect(container.querySelector('.spectate-banner')).toBeTruthy();
    expect(container.querySelector('.dr-input')).toBeNull();
  });
});
