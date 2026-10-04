/**
 * Esc 关闭与草稿守卫测试：useEscClose 接入了 6 个弹层 + 反馈弹窗，是「只能人肉验证」的典型。
 * - CodexModal：Esc 触发 onClose；
 * - FeedbackModal：有草稿时 Esc/遮罩点击先走 window.confirm，确认后才丢草稿关闭；无草稿直接关。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CodexModal } from '../../src/components/CodexModal';
import { FeedbackModal } from '../../src/components/FeedbackModal';

describe('弹层 · Esc 关闭与草稿守卫', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => false)); // 默认「取消」：守卫应拦截关闭
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('CodexModal：Esc 调用 onClose（恰好一次）', async () => {
    const onClose = vi.fn();
    render(<CodexModal onClose={onClose} />);
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('FeedbackModal 无草稿：Esc 直接关闭，不弹确认', async () => {
    const onClose = vi.fn();
    render(<FeedbackModal onClose={onClose} />);
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('FeedbackModal 有草稿：Esc 先确认；「取消」留下，「确定」关闭', async () => {
    const onClose = vi.fn();
    render(<FeedbackModal onClose={onClose} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/描述你遇到的问题/), '出牌按钮在窄屏上被截断');
    await user.keyboard('{Escape}');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled(); // confirm 默认 false：草稿保住

    vi.stubGlobal('confirm', vi.fn(() => true));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('FeedbackModal 有草稿时误触遮罩：同样走确认守卫（防滑动误触丢 500 字）', async () => {
    const onClose = vi.fn();
    const { container } = render(<FeedbackModal onClose={onClose} />);
    await userEvent
      .setup()
      .type(screen.getByPlaceholderText(/描述你遇到的问题/), '随手写的反馈');
    fireEvent.click(container.querySelector('.overlay')!);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});
