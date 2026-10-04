import { mergeConfig, defineWorkspace } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * 客户端测试分项目（vitest 自动发现 vitest.projects.ts；v3+ 该文件名即官方 projects 配置，
 * environmentMatchGlobs 在 v3 已废弃、v4 移除——直接用 projects 形态，升级不再静默变环境）：
 * - logic：test 根目录的纯逻辑用例，node 环境。version.test 的前提是「无 window = 存储不可用」
 *   的最严格场景，必须在 node 下跑（文件内另有 typeof window 断言兜底，环境错配会当场红）。
 * - components：test/components 下的组件用例，jsdom + jest-dom setup。
 * 公共部分（react 插件、@shared alias）mergeConfig 自 vite.config.ts，单一来源不再重复声明。
 */
const base = mergeConfig(viteConfig, {
  test: {
    globals: false,
  },
});

export default defineWorkspace([
  mergeConfig(base, {
    test: {
      name: 'logic',
      include: ['test/*.test.ts'],
      environment: 'node',
    },
  }),
  mergeConfig(base, {
    test: {
      name: 'components',
      include: ['test/components/**/*.test.tsx'],
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
    },
  }),
]);
