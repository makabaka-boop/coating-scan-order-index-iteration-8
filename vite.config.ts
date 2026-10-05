import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // 性能测试对挂钟时间敏感，强制单 fork 顺序执行，避免并行进程抢占导致 4 秒断言抖动
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: ['src/**/*.test.{ts,tsx}'],
    // 浏览器（DOM）行为测试以 .browser.test.tsx 命名，文件内用
    // `@vitest-environment jsdom` 注解显式选择 jsdom；其余测试仍在 node 环境
    setupFiles: ['./src/testSetup.ts'],
  },
});
