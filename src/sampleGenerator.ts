import type { Query } from './types';

/** mulberry32：确定性 32 位伪随机数生成器，页面与 Vitest 共用同一份满规模样本 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FULL_SCALE_N = 200_000;
export const FULL_SCALE_Q = 100_000;

/**
 * 构造确定性满规模样本：
 * - 200000 条读数，值域 0..65535，含成片重复值、0、65535；
 * - 100000 个查询，含全区间、首窗、尾窗、首尾相邻窗口及 k 的两端。
 */
export function generateFullScale(seed = 0xc0a71234): {
  readings: number[];
  queries: Query[];
} {
  const rng = mulberry32(seed);
  const n = FULL_SCALE_N;
  const q = FULL_SCALE_Q;
  const readings: number[] = new Array(n);

  for (let i = 0; i < n; i++) {
    let v: number;
    if (i % 50 < 5) {
      v = 12345; // 成片重复值
    } else if (i % 997 === 0) {
      v = 0; // 下界
    } else if (i % 1009 === 0) {
      v = 65535; // 上界
    } else {
      v = Math.floor(rng() * 65536);
    }
    readings[i] = v;
  }

  const queries: Query[] = new Array(q);

  // 主体：散布在整条序列上的中小滑动窗口，k 在 1、w、中间值之间轮换
  for (let i = 0; i < q; i++) {
    const start = (i * 37 + 11) % (n - 200);
    const w = 1 + (((i * 13) + 7) % 200);
    let k: number;
    switch (i % 4) {
      case 0:
        k = 1;
        break;
      case 1:
        k = w;
        break;
      case 2:
        k = (w + 1) >> 1;
        break;
      default:
        k = 1 + (i % w);
    }
    queries[i] = { start, end: start + w, k };
  }

  // 首端：全区间 k 的两端与中位、首窗
  queries[0] = { start: 0, end: n, k: 1 };
  queries[1] = { start: 0, end: n, k: n };
  queries[2] = { start: 0, end: n, k: (n + 1) >> 1 };
  queries[3] = { start: 0, end: 1000, k: 1 };
  // 首部相邻窗口：不得发生下标偏移
  queries[4] = { start: 0, end: 100, k: 1 };
  queries[5] = { start: 1, end: 101, k: 1 };
  queries[6] = { start: 0, end: 100, k: 100 };
  queries[7] = { start: 1, end: 101, k: 100 };

  // 尾端：尾窗与相邻窗口
  queries[q - 4] = { start: n - 1000, end: n, k: 1000 };
  queries[q - 3] = { start: n - 1, end: n, k: 1 };
  queries[q - 2] = { start: n - 2, end: n, k: 1 };
  queries[q - 1] = { start: n - 2, end: n, k: 2 };

  return { readings, queries };
}
