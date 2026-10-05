/**
 * 小样本预言机：直接复制窗口并排序，取第 k 小（k 从 1 开始）。
 * 仅供 Vitest 与页面内的抽查使用；满规模性能由 Wavelet Matrix 保证。
 */
export function kthBySort(values: ArrayLike<number>, start: number, end: number, k: number): number {
  const slice = sortWindow(values, start, end);
  return slice[k - 1];
}

/**
 * 独立预言机：直接复制窗口、排序后取较低中位数（第 ⌈len/2⌉ 小，
 * 偶数长取两个中位值中较小者），再逐项累加 |reading − median|。
 * 与 Wavelet Matrix 的实现刻意完全不同，供测试交叉核对。
 */
export function madBySort(
  values: ArrayLike<number>,
  start: number,
  end: number,
): { median: number; deviationTotal: number } {
  const slice = sortWindow(values, start, end);
  const median = slice[((slice.length + 1) >> 1) - 1];
  // 逐项求和，禁止任何中间舍入；输入为 ≤ 65535 的整数，结果恒为精确整数
  let deviationTotal = 0;
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i];
    deviationTotal += v >= median ? v - median : median - v;
  }
  return { median, deviationTotal };
}

function sortWindow(values: ArrayLike<number>, start: number, end: number): number[] {
  const slice: number[] = [];
  for (let i = start; i < end; i++) {
    slice.push(values[i]);
  }
  slice.sort((a, b) => a - b);
  return slice;
}

/** 判定两个整数数组完全一致 */
export function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
