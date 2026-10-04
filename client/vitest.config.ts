import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * 客户端测试配置（存在本文件时 vitest 不再读取 vite.config.ts，alias 需在此重复声明）：
 * - 默认 jsdom：组件测试（test/components/**）可渲染 JSX、弹层与交互；
 * - 纯逻辑测试保持 node：version.test.ts 的前提就是「无 window = 存储不可用」的最严格场景。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(process.cwd(), '../shared/src'),
    },
  },
  test: {
    environment: 'jsdom',
    environmentMatchGlobs: [
      ['**/test/bloodLog.test.ts', 'node'],
      ['**/test/version.test.ts', 'node'],
    ],
    setupFiles: ['./test/setup.ts'],
    globals: false,
  },
});
