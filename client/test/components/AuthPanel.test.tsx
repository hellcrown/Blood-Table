/**
 * AuthPanel 组件测试（jsdom）：注册/登录表单是账号系统的唯一入口，此前全靠人工判断。
 * 钉住：匿名态展示、表单校验禁用、提交失败的错误回显（fetch 打桩，绝不发真实请求）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthPanel } from '../../src/components/AuthPanel';

describe('AuthPanel · 注册/登录面板', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network-down'))),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('匿名态：显示「当前：匿名游玩」与注册入口，不渲染表单', () => {
    render(<AuthPanel />);
    expect(screen.getByText('当前：匿名游玩')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('昵称（2-12 字）')).not.toBeInTheDocument();
  });

  it('展开表单：昵称 <2 字或密码 <6 位时注册按钮禁用；不发请求', async () => {
    const user = userEvent.setup();
    render(<AuthPanel />);
    await user.click(screen.getByText('注册 / 登录'));
    const name = screen.getByPlaceholderText('昵称（2-12 字）');
    const pw = screen.getByPlaceholderText('密码（6-32 位）');
    const registerBtn = screen.getByRole('button', { name: '注册新账号' });
    expect(registerBtn).toBeDisabled(); // 空表单
    await user.type(name, '明');
    await user.type(pw, 'abc12');
    expect(registerBtn).toBeDisabled(); // 昵称 1 字 + 密码 5 位
    expect(fetch).not.toHaveBeenCalled();
    await user.type(name, '名');
    await user.type(pw, '3');
    expect(registerBtn).toBeEnabled(); // 2 字 + 6 位
  });

  it('提交失败回显服务端错误信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({ ok: false, msg: '该昵称已被注册' }),
        }),
      ),
    );
    const user = userEvent.setup();
    render(<AuthPanel />);
    await user.click(screen.getByText('注册 / 登录'));
    await user.type(screen.getByPlaceholderText('昵称（2-12 字）'), '小明');
    await user.type(screen.getByPlaceholderText('密码（6-32 位）'), 'secret66');
    await user.click(screen.getByRole('button', { name: '注册新账号' }));
    expect(await screen.findByText('该昵称已被注册')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      '/api/auth/register',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('网络异常时回显兜底文案，不静默失败', async () => {
    const user = userEvent.setup();
    render(<AuthPanel />);
    await user.click(screen.getByText('注册 / 登录'));
    await user.type(screen.getByPlaceholderText('昵称（2-12 字）'), '小明');
    await user.type(screen.getByPlaceholderText('密码（6-32 位）'), 'secret66');
    await user.click(screen.getByRole('button', { name: '注册新账号' }));
    expect(await screen.findByText('网络异常，请稍后再试')).toBeInTheDocument();
  });
});
