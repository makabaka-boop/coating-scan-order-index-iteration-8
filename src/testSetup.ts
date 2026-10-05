/**
 * Vitest 全局 setup：
 * - 注册 jest-dom 风格匹配器（toBeInTheDocument 等），node 环境下导入也无害；
 * - 每个测试后卸载 Testing Library 挂到 document.body 上的组件，
 *   防止浏览器测试之间残留 DOM / 混用两份数据。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
