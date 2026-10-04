/**
 * ErrorBoundary 测试：渲染期异常不得白屏——必须出现兜底 UI（「页面出错了」+ 刷新入口）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../../src/ErrorBoundary';

/** 渲染即抛错的探针组件 */
function Bomb({ message }: { message: string }): never {
  throw new Error(message);
}

describe('ErrorBoundary · 渲染异常兜底', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('子组件渲染抛错：显示兜底面板与错误摘要，而非卸载整树', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React 会把捕获的异常再打一遍，静音
    render(
      <ErrorBoundary>
        <Bomb message="模拟渲染期崩溃" />
      </ErrorBoundary>,
    );
    expect(screen.getByText('页面出错了')).toBeInTheDocument();
    expect(screen.getByText(/模拟渲染期崩溃/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
  });

  it('子组件正常时不干预', () => {
    render(
      <ErrorBoundary>
        <div>正常内容</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('正常内容')).toBeInTheDocument();
    expect(screen.queryByText('页面出错了')).not.toBeInTheDocument();
  });
});
