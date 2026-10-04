/**
 * 组件测试全局准备：
 * - 注入 jest-dom 断言（toBeInTheDocument 等，类型随本文件进入 tsc 程序后全局生效）；
 * - 每个用例后卸载并清理挂载的组件（防单例 net 状态跨用例泄漏）。
 * 纯逻辑测试（node 环境）也会执行本文件：document 不存在时跳过 cleanup。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
