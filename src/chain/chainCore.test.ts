import { describe, expect, it } from 'vitest';
import {
  CHAIN_PERMUTATIONS,
  buildChainSequence,
  chainHeadPreview,
  chainTailPreview,
  computeChain,
  createChainMatcher,
  isValidJoint,
  type ChainPlan,
} from './chainCore';
import { mulberry32 } from '../sampleGenerator';

/** 朴素预言机：从长到短逐一核验 left 后缀与 right 前缀是否严格相等 */
function naiveOverlap(left: ArrayLike<number>, right: ArrayLike<number>): number {
  for (let len = Math.min(left.length, right.length); len >= 1; len--) {
    let ok = true;
    for (let i = 0; i < len; i++) {
      if (left[left.length - len + i] !== right[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return len;
  }
  return 0;
}

/**
 * 短数组暴力枚举预言机：逐一尝试六种有向顺序，
 * 每道接缝用朴素比对求最大重叠，按约束过滤后取合成长度最短者
 * （并列时保留字典序最小，与枚举顺序一致）。
 */
function oracleChain(
  slots: readonly [number[], number[], number[]],
): ChainPlan | null {
  let best: ChainPlan | null = null;
  for (const order of CHAIN_PERMUTATIONS) {
    const o1 = naiveOverlap(slots[order[0]], slots[order[1]]);
    if (o1 < 1 || o1 >= slots[order[1]].length) continue;
    const merged = [...slots[order[0]], ...slots[order[1]].slice(o1)];
    const o2 = naiveOverlap(merged, slots[order[2]]);
    if (o2 < 1 || o2 >= slots[order[2]].length) continue;
    const mergedLength = merged.length + slots[order[2]].length - o2;
    if (best === null || mergedLength < best.mergedLength) {
      best = { order: [...order], overlap1: o1, overlap2: o2, mergedLength };
    }
  }
  return best;
}

function expectPlanEqual(got: ChainPlan | null, want: ChainPlan | null): void {
  if (want === null) {
    expect(got).toBeNull();
    return;
  }
  expect(got).not.toBeNull();
  expect([...got!.order]).toEqual([...want.order]);
  expect(got!.overlap1).toBe(want.overlap1);
  expect(got!.overlap2).toBe(want.overlap2);
  expect(got!.mergedLength).toBe(want.mergedLength);
}

/** 以指定分片预算裁定六种顺序，返回最优方案 */
function chainWithBudget(
  slots: readonly [number[], number[], number[]],
  budget: number,
): ChainPlan | null {
  const matcher = createChainMatcher(slots);
  let guard = 0;
  while (!matcher.step(budget)) {
    if (++guard > 10_000_000) throw new Error('分片推进未收敛');
  }
  return matcher.best();
}

describe('拼接链核心：暴力枚举预言机核对', () => {
  it('随机小样本：窄值域制造重复读数与碰撞，与预言机逐一比对', () => {
    const rng = mulberry32(0xc3a1e001);
    for (let trial = 0; trial < 400; trial++) {
      const slots: [number[], number[], number[]] = [[], [], []];
      for (let s = 0; s < 3; s++) {
        const len = 1 + Math.floor(rng() * 8);
        for (let i = 0; i < len; i++) {
          slots[s].push(Math.floor(rng() * 4));
        }
      }
      expectPlanEqual(computeChain(slots), oracleChain(slots));
    }
  });

  it('随机嫁接样本：共享重叠区的三段打乱后放入槽位，与预言机一致', () => {
    const rng = mulberry32(0xc3a1e002);
    let solved = 0;
    for (let trial = 0; trial < 300; trial++) {
      const seg = (n: number) => Array.from({ length: n }, () => Math.floor(rng() * 4));
      const o1 = seg(1 + Math.floor(rng() * 3)); // 接缝一共享区，≥1 条
      const o2 = seg(1 + Math.floor(rng() * 3)); // 接缝二共享区，≥1 条
      const pieces = [
        [...seg(1 + Math.floor(rng() * 4)), ...o1],
        [...o1, ...seg(Math.floor(rng() * 3)), ...o2],
        [...o2, ...seg(1 + Math.floor(rng() * 3))], // 末份必含新读数
      ];
      // 随机打乱到三个槽位
      const perm = [0, 1, 2];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const slots = [pieces[perm[0]], pieces[perm[1]], pieces[perm[2]]] as [
        number[],
        number[],
        number[],
      ];
      const want = oracleChain(slots);
      if (want !== null) solved++;
      expectPlanEqual(computeChain(slots), want);
    }
    // 嫁接样本应大量有解，确保预言机核对覆盖了合法路径而非全是无解
    expect(solved).toBeGreaterThan(100);
  });

  it('任意分片预算与一次性裁定结果一致', () => {
    const rng = mulberry32(0xc3a1e003);
    for (let trial = 0; trial < 80; trial++) {
      const slots: [number[], number[], number[]] = [[], [], []];
      for (let s = 0; s < 3; s++) {
        const len = 1 + Math.floor(rng() * 10);
        for (let i = 0; i < len; i++) {
          slots[s].push(Math.floor(rng() * 3));
        }
      }
      const want = computeChain(slots);
      for (const budget of [1, 2, 3, 5, 7, 16, 1000]) {
        expectPlanEqual(chainWithBudget(slots, budget), want);
      }
    }
  });

  it('有解时：合成序列长度等于合成长度，头尾预览是其前缀/后缀，两道接缝严格相等', () => {
    const rng = mulberry32(0xc3a1e004);
    let checked = 0;
    for (let trial = 0; trial < 400 && checked < 60; trial++) {
      const slots: [number[], number[], number[]] = [[], [], []];
      for (let s = 0; s < 3; s++) {
        const len = 1 + Math.floor(rng() * 8);
        for (let i = 0; i < len; i++) {
          slots[s].push(Math.floor(rng() * 3));
        }
      }
      const plan = computeChain(slots);
      if (plan === null) continue;
      checked++;
      const seq = buildChainSequence(slots, plan);
      expect(seq.length).toBe(plan.mergedLength);
      expect(chainHeadPreview(slots, plan)).toEqual(seq.slice(0, 8));
      expect(chainTailPreview(slots, plan)).toEqual(seq.slice(Math.max(0, seq.length - 8)));
      // 接缝一：首份末 overlap1 条 ≡ 次份前 overlap1 条
      const x = slots[plan.order[0]];
      const y = slots[plan.order[1]];
      const z = slots[plan.order[2]];
      expect(x.slice(x.length - plan.overlap1)).toEqual(y.slice(0, plan.overlap1));
      // 接缝二：合成前半段 S12 的末 overlap2 条 ≡ 末份前 overlap2 条
      const s12len = x.length + y.length - plan.overlap1;
      expect(seq.slice(s12len - plan.overlap2, s12len)).toEqual(z.slice(0, plan.overlap2));
      // 约束：每道接缝至少重叠一条，且下一份至少贡献一条新读数
      expect(isValidJoint(plan.overlap1, y.length)).toBe(true);
      expect(isValidJoint(plan.overlap2, z.length)).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('拼接链核心：接缝约束边界', () => {
  it('单道接缝约束：至少重叠一条，且下一份至少贡献一条新读数', () => {
    expect(isValidJoint(0, 5)).toBe(false); // 无重叠
    expect(isValidJoint(1, 5)).toBe(true); // 重叠一条
    expect(isValidJoint(4, 5)).toBe(true); // 下一份恰好贡献一条新读数
    expect(isValidJoint(5, 5)).toBe(false); // 下一份被完全吸收
    expect(isValidJoint(1, 1)).toBe(false); // 单条读数被完全吸收
  });

  it('重叠恰为一条即合法', () => {
    // A=[9,1] B=[1,2] C=[2,8]：A→B 重叠 1，合成 [9,1,2]→C 重叠 1
    const plan = computeChain([[9, 1], [1, 2], [2, 8]]);
    expect(plan).not.toBeNull();
    expect([...plan!.order]).toEqual([0, 1, 2]);
    expect(plan!.overlap1).toBe(1);
    expect(plan!.overlap2).toBe(1);
    expect(plan!.mergedLength).toBe(4);
  });

  it('下一份恰好贡献一条新读数（重叠 = |next| − 1）合法', () => {
    // A=[5,1,2] B=[1,2,9]：重叠 2 = |B|−1，B 只贡献新读数 9；合成 [5,1,2,9]→C=[9,7] 重叠 1
    const plan = computeChain([[5, 1, 2], [1, 2, 9], [9, 7]]);
    expect(plan).not.toBeNull();
    expect(plan!.overlap1).toBe(2);
    expect(plan!.overlap2).toBe(1);
    expect(plan!.mergedLength).toBe(5);
    expect(buildChainSequence([[5, 1, 2], [1, 2, 9], [9, 7]], plan!)).toEqual([5, 1, 2, 9, 7]);
  });

  it('下一份被完全吸收（重叠 = |next|）不合法', () => {
    // A=[1,2] B=[1,2]：重叠 2 = |B|，B 不贡献新读数 → 该顺序非法
    expect(computeChain([[1, 2], [1, 2], [3, 4]])).toBeNull();
  });
});

describe('拼接链核心：重复读数', () => {
  it('全同读数且长度递增：只有递增顺序合法，重叠为相邻较短者全长', () => {
    const slots: [number[], number[], number[]] = [
      [7, 7],
      [7, 7, 7],
      [7, 7, 7, 7],
    ];
    const plan = computeChain(slots);
    expect(plan).not.toBeNull();
    expect([...plan!.order]).toEqual([0, 1, 2]);
    expect(plan!.overlap1).toBe(2);
    expect(plan!.overlap2).toBe(3);
    expect(plan!.mergedLength).toBe(4);
    expect(buildChainSequence(slots, plan!)).toEqual([7, 7, 7, 7]);
  });

  it('全同读数等长：任意顺序下一份都被完全吸收，无合法顺序', () => {
    expect(
      computeChain([
        [5, 5],
        [5, 5],
        [5, 5],
      ]),
    ).toBeNull();
  });

  it('周期数据：重复块构成的链与预言机一致', () => {
    const rng = mulberry32(0xc3a1e005);
    for (let trial = 0; trial < 100; trial++) {
      const period = 1 + Math.floor(rng() * 3);
      const unit = Array.from({ length: period }, () => Math.floor(rng() * 3));
      const rep = (times: number, off: number) =>
        Array.from({ length: times }, (_, i) => unit[(i + off) % period]);
      const slots: [number[], number[], number[]] = [
        rep(2 + Math.floor(rng() * 6), 0),
        rep(2 + Math.floor(rng() * 6), Math.floor(rng() * period)),
        rep(2 + Math.floor(rng() * 6), Math.floor(rng() * period)),
      ];
      expectPlanEqual(computeChain(slots), oracleChain(slots));
    }
  });
});

describe('拼接链核心：并列最优按槽位名称顺序裁决', () => {
  it('三种顺序合成长度完全并列：取槽位名称字典序最小者', () => {
    // A=[1,2] B=[2,3] C=[3,1]：(A,B,C)、(B,C,A)、(C,A,B) 三种顺序合成长度均为 4
    const slots: [number[], number[], number[]] = [[1, 2], [2, 3], [3, 1]];
    const legal = CHAIN_PERMUTATIONS.filter((order) => {
      const o1 = naiveOverlap(slots[order[0]], slots[order[1]]);
      if (o1 < 1 || o1 >= slots[order[1]].length) return false;
      const merged = [...slots[order[0]], ...slots[order[1]].slice(o1)];
      const o2 = naiveOverlap(merged, slots[order[2]]);
      return o2 >= 1 && o2 < slots[order[2]].length;
    });
    expect(legal.length).toBe(3); // 确证「完全并列」的前提：三种顺序都合法
    const plan = computeChain(slots);
    expect(plan).not.toBeNull();
    expect(plan!.mergedLength).toBe(4);
    expect([...plan!.order]).toEqual([0, 1, 2]); // A→B→C 字典序最小
  });

  it('并列只发生在合成长度相同者之间；更短方案优先于字典序', () => {
    // A=[8,1,2] B=[2,3] C=[3,1]：(A,B,C) 长度 5，(B,C,A) 与 (C,A,B)……
    // 由预言机直接给出期望，断言被测实现选择同一方案
    const slots: [number[], number[], number[]] = [[8, 1, 2], [2, 3], [3, 1]];
    const want = oracleChain(slots);
    expect(want).not.toBeNull();
    expectPlanEqual(computeChain(slots), want);
    // 且最优长度严格小于其余合法顺序（若存在）
    for (const order of CHAIN_PERMUTATIONS) {
      const o1 = naiveOverlap(slots[order[0]], slots[order[1]]);
      if (o1 < 1 || o1 >= slots[order[1]].length) continue;
      const merged = [...slots[order[0]], ...slots[order[1]].slice(o1)];
      const o2 = naiveOverlap(merged, slots[order[2]]);
      if (o2 < 1 || o2 >= slots[order[2]].length) continue;
      expect(merged.length + slots[order[2]].length - o2).toBeGreaterThanOrEqual(
        want!.mergedLength,
      );
    }
  });
});

describe('拼接链核心：无合法顺序', () => {
  it('三份互不重叠：无解', () => {
    expect(
      computeChain([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    ).toBeNull();
  });

  it('两两可接但三份串不成链：无解', () => {
    // A→B 可接（重叠 1），但任何顺序下 C=[5,6] 都接不上合成序列
    expect(
      computeChain([
        [1, 2],
        [2, 3],
        [5, 6],
      ]),
    ).toBeNull();
  });

  it('三份完全相同：任何顺序下一份都被完全吸收，无解', () => {
    expect(
      computeChain([
        [1, 2, 3],
        [1, 2, 3],
        [1, 2, 3],
      ]),
    ).toBeNull();
  });

  it('值域边界：0 与 65535 参与接缝', () => {
    const plan = computeChain([
      [65535, 0],
      [0, 65535],
      [65535, 0, 1],
    ]);
    expectPlanEqual(
      plan,
      oracleChain([
        [65535, 0],
        [0, 65535],
        [65535, 0, 1],
      ]),
    );
  });
});

describe('拼接链核心：分片推进的工作证据', () => {
  it('完成后状态冻结：重复推进不再改变结果与计数', () => {
    const slots: [number[], number[], number[]] = [
      [3, 1, 4, 1, 5],
      [1, 5, 9, 2],
      [5, 9, 2, 6],
    ];
    const matcher = createChainMatcher(slots);
    let guard = 0;
    while (!matcher.step(3)) {
      if (++guard > 1000) throw new Error('未收敛');
    }
    const best = matcher.best();
    const processedAtDone = matcher.processed;
    expect(matcher.step(1)).toBe(true);
    expect(matcher.step(100)).toBe(true);
    expect(matcher.processed).toBe(processedAtDone);
    expectPlanEqual(matcher.best(), best);
    expectPlanEqual(best, oracleChain(slots));
  });

  it('processed 不超过六种顺序全部接缝与物化的最大线性工作量', () => {
    const rng = mulberry32(0xc3a1e006);
    const slots: [number[], number[], number[]] = [[], [], []];
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < 60; i++) {
        slots[s].push(Math.floor(rng() * 4));
      }
    }
    const matcher = createChainMatcher(slots);
    while (!matcher.step(7)) {
      // 推进至完成
    }
    const n = 60;
    // 上界：6 次接缝一（各 (n-1)+n）+ 6 次物化（各 ≤ 2n）+ 6 次接缝二（各 ≤ (n-1)+2n）
    const upper = 6 * (n - 1 + n) + 6 * 2 * n + 6 * (n - 1 + 2 * n);
    expect(matcher.processed).toBeGreaterThan(0);
    expect(matcher.processed).toBeLessThanOrEqual(upper);
  });
});
