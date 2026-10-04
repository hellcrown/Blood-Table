/**
 * UpdateNotice 组件测试（jsdom）：旧包横幅 / 未读提示条 / 不提示 三态 + 「稍后」按版本持久化。
 * 走真实 version 模块 + fetch 桩（带 content-type 头，覆盖正常 JSON 分支而非异常兜底分支）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateNotice } from '../../src/components/UpdateNotice';
import { LATEST } from '@shared/changelog';

/** 模拟 /api/version 正常 JSON 响应（headers.get 必须可用——缺它 fetchServerVersion 会走异常兜底） */
function stubVersionApi(latest: { date: string; title: string } | null, build: string | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, latest, build }),
    })),
  );
}

const FUTURE = { date: '2999-12-31', title: '未来版本' };
const CURRENT = { date: LATEST?.date ?? '2026-01-01', title: LATEST?.title ?? '当前' };

describe('UpdateNotice · 版本提示', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('服务器构建比本页新：显示旧包横幅（立即刷新/稍后）', async () => {
    stubVersionApi(FUTURE, 'index-server.js');
    render(<UpdateNotice unseen={false} onOpenChangelog={() => {}} onDismissUnseen={() => {}} />);
    expect(await screen.findByText('🆕 新版本已发布')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '立即刷新' })).toBeInTheDocument();
  });

  it('「稍后」绑定具体版本写入 sessionStorage：本会话内不再提示', async () => {
    stubVersionApi(FUTURE, 'index-server.js');
    const { unmount } = render(
      <UpdateNotice unseen={false} onOpenChangelog={() => {}} onDismissUnseen={() => {}} />,
    );
    await screen.findByText('🆕 新版本已发布');
    await userEvent.setup().click(screen.getByRole('button', { name: '稍后' }));
    unmount();
    expect(sessionStorage.getItem('bloodtable.updateDismissed')).toBe('build:index-server.js');
    // 同一版本再挂载：已忽略，不显示横幅
    render(<UpdateNotice unseen={false} onOpenChangelog={() => {}} onDismissUnseen={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('🆕 新版本已发布')).not.toBeInTheDocument();
  });

  it('服务器与本页同版本：不显示横幅；unseen=true 时显示未读提示条并可关闭', async () => {
    stubVersionApi(CURRENT, null);
    const dismiss = vi.fn();
    render(<UpdateNotice unseen onOpenChangelog={() => {}} onDismissUnseen={dismiss} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('🆕 新版本已发布')).not.toBeInTheDocument();
    expect(screen.getByText(/新版本已发布：/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '知道了' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('拿不到服务端版本（老服务端/网络失败）：不显示任何提示', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, headers: { get: () => 'text/html' }, json: async () => ({}) })),
    );
    render(<UpdateNotice unseen={false} onOpenChangelog={() => {}} onDismissUnseen={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('🆕 新版本已发布')).not.toBeInTheDocument();
    expect(screen.queryByText(/新版本已发布：/)).not.toBeInTheDocument();
  });
});
