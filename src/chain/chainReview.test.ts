import { describe, expect, it } from 'vitest';
import { WaveletMatrix } from '../waveletMatrix';
import { CHAIN_REVIEW_MERGED_MAX } from '../types';
import { buildChainSequence, computeChain, type ChainPlan } from './chainCore';
import {
  chainPositionSources,
  reviewChainWindow,
  type ChainReviewOutcome,
  type ChainReviewRequest,
} from './chainReview';
import { mulberry32 } from '../sampleGenerator';

/**
 * 跨接缝窗口一次性复核 · 核心测试。
 *
 * 预言机一（逐窗排序）：直接对合成序列的窗口切片排序，取第 k 小、
 * 严格小于与等于数量，并按合成位置升序找到第 k 次出现的位置——
 * 被测实现必须逐位一致（接缝重叠读数在合成序列中天然只出现一次）。
 *
 * 预言机二（独立来源映射）：不调用被测映射，直接根据方案的
 * 顺序与两道接缝长度重推每个槽位在合成序列上的覆盖区间与
 * 仿射下标，列出命中位置的全部来源，再与被测证据比对；
 * 同时逐条核对所有来源原始下标处的原始读数确实等于命中值。
 */

type Slots = readonly [number[], number[], number[]];

/** 预言机一：逐窗排序的第 k 小结果 */
function oracleReview(
  seq: readonly number[],
  req: ChainReviewRequest,
): { value: number; less: number; equal: number; position: number } {
  const win = seq.slice(req.start, req.end);
  const sorted = [...win].sort((a, b) => a - b);
  const value = sorted[req.k - 1];
  const less = sorted.filter((v) => v < value).length;
  const equal = sorted.filter((v) => v === value).length;
  // 同值读数按合成位置升序：窗口内第 (k−less) 次出现
  let wanted = req.k - less;
  let position = -1;
  for (let p = req.start; p < req.end; p++) {
    if (seq[p] === value) {
      wanted--;
      if (wanted === 0) {
        position = p;
        break;
      }
    }
  }
  return { value, less, equal, position };
}

/** 预言机二：独立重推每个槽位在合成序列上的覆盖区间与原始下标映射 */
function oracleSources(
  slots: Slots,
  plan: ChainPlan,
  position: number,
): Array<{ slotIndex: number; originalIndex: number }> {
  const [s0, s1, s2] = [plan.order[0], plan.order[1], plan.order[2]];
  const len0 = slots[s0].length;
  const len1 = slots[s1].length;
  const coverages: Array<{ slotIndex: number; from: number; to: number }> = [
    { slotIndex: s0, from: 0, to: len0 },
    { slotIndex: s1, from: len0 - plan.overlap1, to: len0 + len1 - plan.overlap1 },
    {
      slotIndex: s2,
      from: len0 + len1 - plan.overlap1 - plan.overlap2,
      to: plan.mergedLength,
    },
  ];
  const out: Array<{ slotIndex: number; originalIndex: number }> = [];
  for (const cov of coverages) {
    if (position >= cov.from && position < cov.to) {
      out.push({ slotIndex: cov.slotIndex, originalIndex: position - cov.from });
    }
  }
  out.sort((a, b) => a.slotIndex - b.slotIndex);
  return out;
}

function assertEvidenceAgainstOracles(
  slots: Slots,
  plan: ChainPlan,
  seq: number[],
  req: ChainReviewRequest,
): ChainReviewOutcome {
  const outcome = reviewChainWindow(slots, plan, req);
  expect(outcome.kind).toBe('evidence');
  if (outcome.kind !== 'evidence') return outcome;

  const want = oracleReview(seq, req);
  expect(outcome.value).toBe(want.value);
  expect(outcome.lessCount).toBe(want.less);
  expect(outcome.equalCount).toBe(want.equal);
  expect(outcome.position).toBe(want.position);
  expect(outcome.windowLength).toBe(req.end - req.start);

  const wantSources = oracleSources(slots, plan, want.position);
  expect(outcome.sources.map((s) => [s.slotIndex, s.originalIndex])).toEqual(
    wantSources.map((s) => [s.slotIndex, s.originalIndex]),
  );

  // 每条来源证据：原始下标处读数必须与命中值严格相等（接缝相等性的独立核对）
  for (const src of outcome.sources) {
    expect(slots[src.slotIndex][src.originalIndex]).toBe(want.value);
  }
  // 定位位置处的合成读数当然等于命中值
  expect(seq[outcome.position]).toBe(want.value);
  return outcome;
}

/** 枚举合成序列上全部非空窗口与全部合法 k，与逐窗排序预言机逐一比对 */
function assertAllWindows(slots: Slots, plan: ChainPlan): void {
  const seq = buildChainSequence(slots, plan);
  expect(seq.length).toBe(plan.mergedLength);
  for (let start = 0; start < seq.length; start++) {
    for (let end = start + 1; end <= seq.length; end++) {
      for (let k = 1; k <= end - start; k++) {
        assertEvidenceAgainstOracles(slots, plan, seq, { start, end, k });
      }
    }
  }
}

describe('跨接缝窗口复核：Wavelet Matrix 精确计数原语', () => {
  it('countLess 与逐元素计数一致（含 0、65535、重复值、65536 哨兵）', () => {
    const rng = mulberry32(0x7e570001);
    const values = Array.from({ length: 300 }, () => {
      const bucket = rng();
      if (bucket < 0.2) return 0;
      if (bucket < 0.4) return 65535;
      return Math.floor(rng() * 7); // 窄值域制造大量重复
    });
    const wm = new WaveletMatrix(values);
    for (let start = 0; start < values.length; start += 17) {
      for (let end = start + 1; end <= values.length; end += 23) {
        for (const v of [0, 1, 3, 6, 7, 65535, 65536]) {
          const naive = values.slice(start, end).filter((x) => x < v).length;
          expect(wm.countLess(start, end, v)).toBe(naive);
        }
      }
    }
    // 边界：countLess(...,0) 恒为 0；countLess(...,65536) 恒为窗口长度
    expect(wm.countLess(0, values.length, 0)).toBe(0);
    expect(wm.countLess(10, 20, 65536)).toBe(10);
  });

  it('全相等窗口：less=0、equal=窗口长度，定位随 k 取到第 k 个位置', () => {
    const slots: Slots = [
      [7, 7],
      [7, 7, 7],
      [7, 7, 7, 7],
    ];
    const plan = computeChain(slots);
    expect(plan).not.toBeNull();
    assertAllWindows(slots, plan!);
  });
});

describe('跨接缝窗口复核：逐窗排序预言机全窗口穷举', () => {
  it('窄值域随机三段：全部窗口 × 全部 k 与预言机一致，来源映射独立核对', () => {
    const rng = mulberry32(0xc3a1e101);
    let checked = 0;
    for (let trial = 0; trial < 60 && checked < 20; trial++) {
      const slots: Slots = [[], [], []];
      for (let s = 0; s < 3; s++) {
        const len = 1 + Math.floor(rng() * 6);
        for (let i = 0; i < len; i++) slots[s].push(Math.floor(rng() * 4));
      }
      const plan = computeChain(slots);
      if (plan === null) continue;
      assertAllWindows(slots, plan);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('嫁接样本：第二道接缝常跨过第一道，覆盖多槽位同证', () => {
    const rng = mulberry32(0xc3a1e102);
    let multi = 0;
    for (let trial = 0; trial < 120; trial++) {
      const seg = (n: number) => Array.from({ length: n }, () => Math.floor(rng() * 4));
      const o1 = seg(1 + Math.floor(rng() * 3));
      const o2 = seg(1 + Math.floor(rng() * 3));
      const pieces = [
        [...seg(1 + Math.floor(rng() * 4)), ...o1],
        [...o1, ...seg(Math.floor(rng() * 3)), ...o2],
        [...o2, ...seg(1 + Math.floor(rng() * 3))],
      ];
      const perm = [0, 1, 2];
      for (let i = 2; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
      }
      const slots = [pieces[perm[0]], pieces[perm[1]], pieces[perm[2]]] as Slots;
      const plan = computeChain(slots);
      if (plan === null) continue;
      const seq = buildChainSequence(slots, plan);
      for (let p = 0; p < seq.length; p++) {
        if (oracleSources(slots, plan, p).length >= 2) multi++;
      }
      assertAllWindows(slots, plan);
    }
    // 嫁接构造下接缝重叠区必然存在，应有大量位置被多槽位覆盖
    expect(multi).toBeGreaterThan(0);
  });
});

describe('跨接缝窗口复核：第二道接缝跨过第一道（三份同证）', () => {
  // x=[1,2,3] y=[2,3,4] z=[1,2,3,4,5]，唯一合法顺序 (x,y,z)：
  // 接缝一重叠 [2,3]（o1=2），合成 S=[1,2,3,4]；
  // 接缝二：S 后缀 [1,2,3,4] ≡ z 前缀（o2=4），第二道接缝回退 4 位、
  // 跨过第一道（S 中 [2,3] 是接缝一重叠区），最终合成 [1,2,3,4,5]。
  const slots: Slots = [
    [1, 2, 3],
    [2, 3, 4],
    [1, 2, 3, 4, 5],
  ];
  const plan = computeChain(slots)!;

  it('方案锁定：(A,B,C)、o1=2、o2=4、合成长度 5', () => {
    expect([...plan.order]).toEqual([0, 1, 2]);
    expect(plan.overlap1).toBe(2);
    expect(plan.overlap2).toBe(4);
    expect(plan.mergedLength).toBe(5);
    expect(buildChainSequence(slots, plan)).toEqual([1, 2, 3, 4, 5]);
  });

  it('合成位置 1/2 被三份共同覆盖，原始下标各自正确且同值', () => {
    // 位置 1（值 2）：A 下标 1、B 下标 0、z 下标 1
    expect(chainPositionSources(slots, plan, 1).map((s) => [s.slotIndex, s.originalIndex])).toEqual([
      [0, 1],
      [1, 0],
      [2, 1],
    ]);
    // 位置 2（值 3）：A 下标 2、B 下标 1、z 下标 2
    expect(chainPositionSources(slots, plan, 2).map((s) => [s.slotIndex, s.originalIndex])).toEqual([
      [0, 2],
      [1, 1],
      [2, 2],
    ]);
    // 位置 0（值 1）：仅 A 与 z；位置 3（值 4）：B 与 z；位置 4（值 5）：仅 z
    expect(chainPositionSources(slots, plan, 0).map((s) => s.slotIndex)).toEqual([0, 2]);
    expect(chainPositionSources(slots, plan, 3).map((s) => s.slotIndex)).toEqual([1, 2]);
    expect(chainPositionSources(slots, plan, 4).map((s) => s.slotIndex)).toEqual([2]);
  });

  it('整窗第 2 小：值 2 命中位置 1，三条来源全部列出；计数正确', () => {
    const out = assertEvidenceAgainstOracles(slots, plan, [1, 2, 3, 4, 5], {
      start: 0,
      end: 5,
      k: 2,
    });
    if (out.kind !== 'evidence') throw new Error('unreachable');
    expect(out.value).toBe(2);
    expect(out.lessCount).toBe(1);
    expect(out.equalCount).toBe(1);
    expect(out.position).toBe(1);
    expect(out.sources).toHaveLength(3);
  });

  it('跨接缝子窗口与全部 k 仍与逐窗排序一致', () => {
    assertAllWindows(slots, plan);
  });
});

describe('跨接缝窗口复核：重复值按合成位置升序定位', () => {
  // x=[5,5,1] y=[1,5,5,2] z=[2,5,9]：接缝一 [1]（o1=1），S=[5,5,1,5,5,2]；
  // 接缝二 [2]（o2=1），最终合成 [5,5,1,5,5,2,5,9]（四个 5 分布在接缝前后）。
  const slots: Slots = [
    [5, 5, 1],
    [1, 5, 5, 2],
    [2, 5, 9],
  ];
  const plan = computeChain(slots)!;
  const seq = buildChainSequence(slots, plan);

  it('方案与合成序列锁定', () => {
    expect(plan.overlap1).toBe(1);
    expect(plan.overlap2).toBe(1);
    expect(seq).toEqual([5, 5, 1, 5, 5, 2, 5, 9]);
  });

  it('窗口 [0,6) 中四个 5：第 3..6 小同为 5，位置随出现次序推进', () => {
    // seq=[5,5,1,5,5,2,5,9]；窗口 [0,6)=[5,5,1,5,5,2]
    // 排序 1,2,5,5,5,5 → 第 3..6 小为四个 5，位置依次 0、1、3、4
    assertEvidenceAgainstOracles(slots, plan, seq, { start: 0, end: 6, k: 3 });
    assertEvidenceAgainstOracles(slots, plan, seq, { start: 0, end: 6, k: 4 });
    assertEvidenceAgainstOracles(slots, plan, seq, { start: 0, end: 6, k: 5 });
    assertEvidenceAgainstOracles(slots, plan, seq, { start: 0, end: 6, k: 6 });
    const kth3 = reviewChainWindow(slots, plan, { start: 0, end: 6, k: 3 });
    const kth4 = reviewChainWindow(slots, plan, { start: 0, end: 6, k: 4 });
    const kth5 = reviewChainWindow(slots, plan, { start: 0, end: 6, k: 5 });
    const kth6 = reviewChainWindow(slots, plan, { start: 0, end: 6, k: 6 });
    expect(kth3.kind).toBe('evidence');
    expect(kth4.kind).toBe('evidence');
    expect(kth5.kind).toBe('evidence');
    expect(kth6.kind).toBe('evidence');
    if (
      kth3.kind === 'evidence' &&
      kth4.kind === 'evidence' &&
      kth5.kind === 'evidence' &&
      kth6.kind === 'evidence'
    ) {
      expect([kth3.value, kth4.value, kth5.value, kth6.value]).toEqual([5, 5, 5, 5]);
      expect([kth3.position, kth4.position, kth5.position, kth6.position]).toEqual([0, 1, 3, 4]);
      expect(kth4.lessCount).toBe(2); // 窗口内严格小于 5：1 与 2
      expect(kth4.equalCount).toBe(4);
    }
  });

  it('接缝处同值：重叠 5 的来源随命中位置给出对应槽位', () => {
    assertAllWindows(slots, plan);
  });
});

describe('跨接缝窗口复核：窗口与 k 边界', () => {
  const slots: Slots = [
    [9, 1, 2],
    [2, 3],
    [3, 8],
  ];
  const plan = computeChain(slots)!; // 合成 [9,1,2,3,8]

  it('单元素窗口：less=0、equal=1，唯一种位置唯一', () => {
    for (let p = 0; p < plan.mergedLength; p++) {
      assertEvidenceAgainstOracles(slots, plan, [9, 1, 2, 3, 8], {
        start: p,
        end: p + 1,
        k: 1,
      });
    }
  });

  it('k=1 与 k=窗口长度：最小值/最大值两端', () => {
    assertEvidenceAgainstOracles(slots, plan, [9, 1, 2, 3, 8], { start: 0, end: 5, k: 1 });
    assertEvidenceAgainstOracles(slots, plan, [9, 1, 2, 3, 8], { start: 0, end: 5, k: 5 });
    const min = reviewChainWindow(slots, plan, { start: 0, end: 5, k: 1 });
    const max = reviewChainWindow(slots, plan, { start: 0, end: 5, k: 5 });
    if (min.kind === 'evidence' && max.kind === 'evidence') {
      expect(min.value).toBe(1);
      expect(min.position).toBe(1);
      expect(max.value).toBe(9);
      expect(max.position).toBe(0);
    }
  });

  it('窗口恰好只覆盖第二道接缝（[2,4)=[2,3]）', () => {
    assertEvidenceAgainstOracles(slots, plan, [9, 1, 2, 3, 8], { start: 2, end: 4, k: 1 });
    assertEvidenceAgainstOracles(slots, plan, [9, 1, 2, 3, 8], { start: 2, end: 4, k: 2 });
  });

  it('非法窗口/k：返回 error，不物化、不产生证据', () => {
    expect(reviewChainWindow(slots, plan, { start: 4, end: 2, k: 1 }).kind).toBe('error');
    expect(reviewChainWindow(slots, plan, { start: -1, end: 2, k: 1 }).kind).toBe('error');
    expect(reviewChainWindow(slots, plan, { start: 0, end: 6, k: 1 }).kind).toBe('error');
    expect(reviewChainWindow(slots, plan, { start: 0, end: 5, k: 0 }).kind).toBe('error');
    expect(reviewChainWindow(slots, plan, { start: 0, end: 5, k: 6 }).kind).toBe('error');
    expect(reviewChainWindow(slots, plan, { start: 1.5, end: 3, k: 1 }).kind).toBe('error');
    const err = reviewChainWindow(slots, plan, { start: 0, end: 5, k: 6 });
    if (err.kind === 'error') expect(err.errors.length).toBeGreaterThan(0);
  });
});

describe('跨接缝窗口复核：容量闸门', () => {
  /** 构造唯一合法链（互不相交值域 + 植入重叠），合成长度 = 3n−2o */
  function buildTriple(n: number, o: number): Slots {
    const x = Array.from({ length: n }, (_, i) => 1000 + ((i * 7) % 100));
    const y = Array.from({ length: n }, (_, i) => 2000 + ((i * 13) % 100));
    const z = Array.from({ length: n }, (_, i) => 3000 + ((i * 17) % 100));
    for (let j = 0; j < o; j++) y[j] = x[n - o + j];
    for (let j = 0; j < o; j++) z[j] = y[n - o + j];
    return [x, y, z];
  }

  it('合成长度恰为上限 200000：复核可用', () => {
    // n=70000、o=5000：3*70000−2*5000 = 200000
    const slots = buildTriple(70_000, 5_000);
    const plan = computeChain(slots);
    expect(plan).not.toBeNull();
    expect(plan!.mergedLength).toBe(CHAIN_REVIEW_MERGED_MAX);
    const out = reviewChainWindow(slots, plan!, { start: 0, end: plan!.mergedLength, k: 1 });
    expect(out.kind).toBe('evidence');
  });

  it('合成长度 200001 超过上限：只禁用复核，不否定拼接方案', () => {
    // n=70000、o=4999：210000−9998 = 200002；取 o 使 3n−2o = 200001 不可能（奇偶），
    // 改用 n=70001、o=5001：210003−10002 = 200001
    const slots = buildTriple(70_001, 5_001);
    const plan = computeChain(slots);
    expect(plan).not.toBeNull();
    expect(plan!.mergedLength).toBe(200_001);
    const out = reviewChainWindow(slots, plan!, { start: 0, end: 10, k: 1 });
    expect(out.kind).toBe('unavailable');
    if (out.kind === 'unavailable') {
      expect(out.mergedLength).toBe(200_001);
    }
  });

  it('无重叠三段 60 万：方案若不成立由 chainCore 裁定；容量闸门只在复核处把关', () => {
    // 直接构造一个合法但超长的方案（n=200000、o=1：合成长度 599998）
    const slots = buildTriple(200_000, 1);
    const plan = computeChain(slots);
    expect(plan).not.toBeNull();
    expect(plan!.mergedLength).toBe(599_998);
    expect(reviewChainWindow(slots, plan!, { start: 0, end: 2, k: 1 }).kind).toBe(
      'unavailable',
    );
  });
});
