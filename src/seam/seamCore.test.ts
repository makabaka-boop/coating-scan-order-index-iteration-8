import { describe, expect, it } from 'vitest';
import {
  CONTEXT_MAX,
  SENTINEL,
  computeSeamOverlap,
  createSeamMatcher,
  headContext,
  tailContext,
} from './seamCore';
import { mulberry32 } from '../sampleGenerator';

/** 朴素预言机：从长到短逐一核验 left 后缀与 right 前缀是否严格相等 */
function naiveOverlap(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const n = left.length;
  const m = right.length;
  for (let len = Math.min(n, m); len >= 1; len--) {
    let ok = true;
    for (let i = 0; i < len; i++) {
      if (left[n - len + i] !== right[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return len;
  }
  return 0;
}

/** 以指定分片预算跑完整个匹配，返回重叠长度 */
function overlapWithBudget(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  budget: number,
): number {
  const matcher = createSeamMatcher(left, right);
  let guard = 0;
  while (!matcher.step(budget)) {
    if (++guard > 10_000_000) throw new Error('分片推进未收敛');
  }
  return matcher.overlap();
}

describe('接缝核心：朴素预言机核对', () => {
  it('随机小样本：窄值域制造碰撞，与预言机逐一比对', () => {
    const rng = mulberry32(0x5ea12345);
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rng() * 24);
      const m = 1 + Math.floor(rng() * 24);
      const left: number[] = [];
      const right: number[] = [];
      for (let i = 0; i < n; i++) left.push(Math.floor(rng() * 5));
      for (let i = 0; i < m; i++) right.push(Math.floor(rng() * 5));
      // 三分之一的样本把 left 的一段后缀嫁接到 right 前缀，制造非零接缝
      if (trial % 3 === 0) {
        const len = 1 + Math.floor(rng() * Math.min(n, m));
        for (let i = 0; i < len; i++) right[i] = left[n - len + i];
      }
      expect(computeSeamOverlap(left, right)).toBe(naiveOverlap(left, right));
    }
  });

  it('随机小样本：任意分片预算与一次性计算结果一致（分片延续前缀函数状态）', () => {
    const rng = mulberry32(0x5ea16789);
    for (let trial = 0; trial < 60; trial++) {
      const n = 1 + Math.floor(rng() * 30);
      const m = 1 + Math.floor(rng() * 30);
      const left: number[] = [];
      const right: number[] = [];
      for (let i = 0; i < n; i++) left.push(Math.floor(rng() * 4));
      for (let i = 0; i < m; i++) right.push(Math.floor(rng() * 4));
      const want = naiveOverlap(left, right);
      for (const budget of [1, 2, 3, 5, 7, 16, 1000]) {
        expect(overlapWithBudget(left, right, budget)).toBe(want);
      }
    }
  });

  it('周期数据：不同周期与相位，与预言机一致', () => {
    const cases: Array<{ left: number[]; right: number[] }> = [];
    for (const period of [1, 2, 3, 5]) {
      const unit = Array.from({ length: period }, (_, i) => (i * 7 + 3) % 11);
      const repeat = (times: number, offset: number) =>
        Array.from({ length: times }, (_, i) => unit[(i + offset) % period]);
      cases.push({ left: repeat(9, 0), right: repeat(7, 1) });
      cases.push({ left: repeat(6, 2), right: repeat(6, 2) });
      cases.push({ left: repeat(4, 0), right: repeat(11, 0) });
    }
    for (const { left, right } of cases) {
      expect(computeSeamOverlap(left, right)).toBe(naiveOverlap(left, right));
    }
    // 经典陷阱：高自相似串，手工核验的期望值
    // left=[1,1,1,2,1,1,1] 的末 3 条与 right=[1,1,1,2] 的前 3 条相等，长度 4 不等
    expect(computeSeamOverlap([1, 1, 1, 2, 1, 1, 1], [1, 1, 1, 2])).toBe(3);
    // left=[2,1,1,1,2,1,1] 的末 2 条与 right=[1,1,2] 的前 2 条相等，长度 3 不等
    expect(computeSeamOverlap([2, 1, 1, 1, 2, 1, 1], [1, 1, 2])).toBe(2);
  });

  it('全同：重叠为两侧长度的较小者', () => {
    expect(computeSeamOverlap([7, 7, 7, 7, 7], [7, 7, 7])).toBe(3);
    expect(computeSeamOverlap([9, 9], [9, 9, 9, 9])).toBe(2);
    expect(computeSeamOverlap(new Array(50).fill(0), new Array(50).fill(0))).toBe(50);
    expect(computeSeamOverlap([65535], [65535, 65535, 65535])).toBe(1);
  });

  it('包含：right 出现在 left 内部但不触及末端，不算接缝', () => {
    expect(computeSeamOverlap([9, 1, 2, 3, 9, 9], [1, 2, 3])).toBe(0);
    expect(computeSeamOverlap([5, 1, 2, 3, 4], [1, 2, 3])).toBe(0);
    // right 整体就是 left 的后缀：接缝成立，长度即 right 全长
    expect(computeSeamOverlap([8, 1, 2, 3], [1, 2, 3])).toBe(3);
    expect(computeSeamOverlap([1, 2, 3, 1, 2, 3], [1, 2, 3])).toBe(3);
  });

  it('单元素：相等为 1，不等为 0', () => {
    expect(computeSeamOverlap([5], [5])).toBe(1);
    expect(computeSeamOverlap([5], [6])).toBe(0);
    expect(computeSeamOverlap([0], [0])).toBe(1);
    expect(computeSeamOverlap([65535], [65535])).toBe(1);
    expect(computeSeamOverlap([0], [65535])).toBe(0);
  });

  it('零重叠：值域不相交或末端/首端不等', () => {
    expect(computeSeamOverlap([1, 2, 3, 4], [100, 101, 102])).toBe(0);
    expect(computeSeamOverlap([0, 0, 0], [1, 1, 1])).toBe(0);
    expect(computeSeamOverlap([4, 3, 2, 1], [2, 3, 4])).toBe(0);
  });

  it('反向相等不算接缝', () => {
    // right 是 left 的逆序：整体镜像相等，但只有真正接触两端的最长段计入
    expect(computeSeamOverlap([1, 2, 3], [3, 2, 1])).toBe(1); // 仅末端 3 ≡ 首端 3
    expect(computeSeamOverlap([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBe(1);
    expect(computeSeamOverlap([1, 2, 3, 1, 2, 3], [3, 2, 1, 3, 2, 1])).toBe(1);
    // 含逆序相似段且首末值也不同：完全无接缝
    expect(computeSeamOverlap([1, 2, 3, 4], [9, 3, 2, 1])).toBe(0);
    // 回文式结构是真实的后缀-前缀相等（left 末 3 条 ≡ right 前 3 条），不属于反向陷阱
    expect(computeSeamOverlap([9, 1, 2, 1], [1, 2, 1, 9])).toBe(3);
  });

  it('内部重复与未接触两端的相似段不算接缝', () => {
    // left 内部有 [5,5,5]，right 以 [5,5] 开头，但 left 末端是 9
    expect(computeSeamOverlap([5, 5, 5, 9], [5, 5, 8])).toBe(0);
    // 两侧中段同为 [6,6,6]，但 left 末端 0、right 首端 7
    expect(computeSeamOverlap([0, 6, 6, 6, 0], [7, 6, 6, 6, 7])).toBe(0);
    // 相似段 [2,3] 在 left 内部、right 以之开头，但 left 末端是 4
    expect(computeSeamOverlap([2, 3, 2, 3, 4], [2, 3, 9])).toBe(0);
  });

  it('值域边界：0 与 65535 参与匹配，哨兵在值域之外', () => {
    expect(SENTINEL).toBeLessThan(0);
    expect(computeSeamOverlap([65535, 0, 65535], [65535, 0])).toBe(1);
    expect(computeSeamOverlap([0, 65535, 0], [65535, 0])).toBe(2);
    expect(computeSeamOverlap([0, 0, 65535], [0, 65535])).toBe(2);
  });

  it('分片推进：处理元素总数恰为 (|right|-1)+|left|，完成后状态冻结', () => {
    const left = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const right = [6, 5, 3, 5, 8];
    const matcher = createSeamMatcher(left, right);
    let calls = 0;
    while (!matcher.step(1)) {
      calls++;
      if (calls > 1000) throw new Error('未收敛');
    }
    expect(matcher.processed).toBe(right.length - 1 + left.length);
    expect(matcher.overlap()).toBe(naiveOverlap(left, right));
    // 完成后重复推进是安全的空操作
    const processedAtDone = matcher.processed;
    expect(matcher.step(1)).toBe(true);
    expect(matcher.processed).toBe(processedAtDone);
    expect(matcher.overlap()).toBe(naiveOverlap(left, right));
  });
});

describe('接缝核心：上下文截取', () => {
  it('不足上限时取全部，超过时取末尾/开头各 CONTEXT_MAX 条', () => {
    expect(CONTEXT_MAX).toBe(8);
    expect(tailContext([1, 2, 3])).toEqual([1, 2, 3]);
    expect(headContext([1, 2, 3])).toEqual([1, 2, 3]);
    expect(tailContext([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(headContext([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tailContext([1, 2, 3, 4, 5, 6, 7, 8])).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
