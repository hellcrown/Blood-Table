/**
 * 心有灵犀 · 对局页组件测试（jsdom）：钉住交互口径——
 * 1. 空文本提交禁用；输入后提交/回车发 cSubmit；服务端确认后按钮转「修改答案」（可覆写口径）；
 * 2. 历史对照行渲染双方原文与 ×/✓，相遇轮金框高亮（cv-same）；
 * 3. 终局相遇文案「用了 N 轮」、房主再来一局发 cRematch；观战无输入框。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConvergeTable } from '../../src/pages/ConvergeTable';
import { net } from '../../src/net/socket';
import type { ConvergeView } from '@shared/convergeProtocol';

vi.mock('../../src/audio/sound', () => ({ playSfx: vi.fn() }));

const ME = 'u-me';

function cvView(overrides?: Partial<ConvergeView>): ConvergeView {
  return {
    kind: 'converge',
    mode: 'converge',
    code: 'TEST',
    hostId: ME,
    phase: 'playing',
    round: 1,
    players: [
      { id: ME, name: '我', seat: 0, submitted: false },
      { id: 'u2', name: '对手', seat: 1, submitted: false },
    ],
    rounds: [],
    myText: null,
    result: null,
    spectator: false,
    startedAt: 1_700_000_000_000,
    log: [],
    logSeq: 0,
    ...overrides,
  };
}

describe('ConvergeTable · 心有灵犀对局页', () => {
  beforeEach(() => {
    net.playerId = ME;
  });
  afterEach(() => {
    net.playerId = null;
    vi.restoreAllMocks();
  });

  it('空文本禁用提交；输入后点提交/回车发 cSubmit；服务端确认后按钮转「修改答案」', () => {
    const sendSpy = vi.spyOn(net, 'send');
    const { rerender } = render(<ConvergeTable view={cvView()} />);
    const btn = screen.getByRole('button', { name: '提交' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    const input = screen.getByPlaceholderText(/第 1 轮/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  午睡  ' } });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(sendSpy).toHaveBeenCalledWith({ t: 'cSubmit', text: '午睡' }); // 首尾空白本地清理
    // 服务端确认已提交（myText 回填）：按钮转「修改答案」，再点仍发 cSubmit（覆写口径）
    rerender(
      <ConvergeTable
        view={cvView({
          myText: '午睡',
          players: [
            { id: ME, name: '我', seat: 0, submitted: true },
            { id: 'u2', name: '对手', seat: 1, submitted: false },
          ],
        })}
      />,
    );
    const revise = screen.getByRole('button', { name: '修改答案' });
    fireEvent.click(revise);
    expect(sendSpy).toHaveBeenLastCalledWith({ t: 'cSubmit', text: '午睡' });
    // 回车同样提交
    fireEvent.change(input, { target: { value: '梨' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sendSpy).toHaveBeenLastCalledWith({ t: 'cSubmit', text: '梨' });
  });

  it('历史对照行：双方原文 + ×/✓；相遇轮 cv-same 高亮；我的答案带「·你」标', () => {
    const { container } = render(
      <ConvergeTable
        view={cvView({
          round: 3,
          rounds: [
            { n: 1, same: false, entries: [{ seat: 0, text: '午睡' }, { seat: 1, text: '肥牛卷' }] },
            { n: 2, same: true, entries: [{ seat: 0, text: '６' }, { seat: 1, text: '6' }] },
          ],
        })}
      />,
    );
    const rows = container.querySelectorAll('.cv-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('午睡');
    expect(rows[0].textContent).toContain('肥牛卷');
    expect(rows[0].querySelector('.cv-x')?.textContent).toBe('×');
    expect(rows[1].querySelector('.cv-x')?.textContent).toBe('✓');
    expect(rows[1].classList.contains('cv-same')).toBe(true); // 相遇轮金框
    expect(rows[0].classList.contains('cv-same')).toBe(false);
    expect(rows[0].querySelector('.cv-pill')?.textContent).toContain('·你'); // seat0 是我
  });

  it('gameover 相遇：文案带轮数与相遇词；房主「再来一局」发 cRematch；返回房间发 backToRoom', () => {
    const sendSpy = vi.spyOn(net, 'send');
    render(
      <ConvergeTable
        view={cvView({
          phase: 'gameover',
          result: { matched: true, rounds: 12, word: '6', reason: 'match' },
          rounds: [{ n: 12, same: true, entries: [{ seat: 0, text: '6' }, { seat: 1, text: '６' }] }],
        })}
      />,
    );
    expect(screen.getByText(/用了/).textContent).toContain('12');
    expect(screen.getByText(/我们都想到了/).textContent).toContain('6');
    fireEvent.click(screen.getByRole('button', { name: '再来一局' }));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'cRematch' });
    fireEvent.click(screen.getByRole('button', { name: '返回房间' }));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'backToRoom' });
  });

  it('gameover 未相遇（对方离开）：显示原因与已揭示轮数；非房主只见等待提示', () => {
    render(
      <ConvergeTable
        view={cvView({
          hostId: 'u2', // 我不是房主
          phase: 'gameover',
          result: { matched: false, rounds: 3, word: '', reason: 'leave' },
        })}
      />,
    );
    const line = screen.getByText(/对方中途离开/);
    expect(line.textContent).toContain('3');
    expect(screen.queryByRole('button', { name: '再来一局' })).toBeNull();
    expect(screen.getByText('等待房主开始下一局…')).toBeTruthy();
  });

  it('观战：无输入框与提交按钮，显示观战横幅；仍能看到历史', () => {
    const { container } = render(
      <ConvergeTable
        view={cvView({
          spectator: true,
          players: [
            { id: 'a1', name: '甲', seat: 0, submitted: false },
            { id: 'b2', name: '乙', seat: 1, submitted: false },
          ],
          rounds: [{ n: 1, same: false, entries: [{ seat: 0, text: '午睡' }, { seat: 1, text: '肥牛卷' }] }],
        })}
      />,
    );
    expect(container.querySelector('.spectate-banner')?.textContent).toContain('观战中');
    expect(screen.queryByPlaceholderText(/第 1 轮/)).toBeNull();
    expect(screen.queryByRole('button', { name: '提交' })).toBeNull();
    expect(container.querySelectorAll('.cv-row')).toHaveLength(1);
  });

  it('进行中房主可「终止本局」发 cAbort', () => {
    const sendSpy = vi.spyOn(net, 'send');
    render(<ConvergeTable view={cvView()} />);
    fireEvent.click(screen.getByRole('button', { name: '终止本局' }));
    expect(sendSpy).toHaveBeenCalledWith({ t: 'cAbort' });
  });

  it('历史滚动区：轮数推进/终局时 scrollTo 到最新一轮；0 轮不滚；后台态直接跳到底（太久看不到新词的兜底）', () => {
    // jsdom 无布局，无法真滚：桩掉原型方法只观察调用参数（scrollTo 在 jsdom 可能未实现，手动桩 + 手动还原）
    const calls: unknown[][] = [];
    const scrollToStub = function (this: unknown, ...args: unknown[]) {
      calls.push(args);
    } as unknown as typeof HTMLElement.prototype.scrollTo;
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: scrollToStub, configurable: true, writable: true });
    // 可见性桩：实例自有属性遮住原型 getter，finally 删掉即还原
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const round1 = { n: 1, same: false, entries: [{ seat: 0, text: '午睡' }, { seat: 1, text: '肥牛卷' }] };
    const round2 = { n: 2, same: false, entries: [{ seat: 0, text: '雪' }, { seat: 1, text: '冰' }] };
    try {
      const { rerender } = render(<ConvergeTable view={cvView()} />);
      expect(calls).toHaveLength(0); // 0 轮：没有可滚的内容
      rerender(<ConvergeTable view={cvView({ round: 2, rounds: [round1] })} />);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.at(-1)?.[0]).toMatchObject({ behavior: 'smooth' }); // 前台：平滑滚（jsdom 无布局 scrollHeight 恒 0，只验调用形态）
      // 后台（切走 App 等对方）：不产生动画帧，平滑滚动会卡住 → 必须即时跳到底
      hidden = true;
      rerender(<ConvergeTable view={cvView({ round: 3, rounds: [round1, round2] })} />);
      expect(calls.at(-1)?.[0]).toMatchObject({ behavior: 'auto' });
      // 终局（未相遇，轮数不变）也触发一次：把最后一轮送进视野
      const before = calls.length;
      rerender(
        <ConvergeTable
          view={cvView({
            phase: 'gameover',
            result: { matched: false, rounds: 2, word: '', reason: 'abort' },
            rounds: [round1, round2],
          })}
        />,
      );
      expect(calls.length).toBe(before + 1);
    } finally {
      delete (document as { hidden?: boolean }).hidden;
      if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollTo', orig);
      else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it('历史容器挂 ref：相遇之路面板是内部滚动区（页面本体不滚的布局前提）', () => {
    const { container } = render(
      <ConvergeTable
        view={cvView({ rounds: [{ n: 1, same: false, entries: [{ seat: 0, text: '午睡' }, { seat: 1, text: '肥牛卷' }] }] })}
      />,
    );
    const history = container.querySelector('.cv-history') as HTMLElement | null;
    expect(history).not.toBeNull();
    expect(history?.scrollTop).toBe(0); // ref 已挂上（scrollTop 属性存在即证明是元素实例）
  });
});
