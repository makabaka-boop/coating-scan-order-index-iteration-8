import { describe, expect, it } from 'vitest';
import { READINGS_MAX } from '../types';
import { mulberry32 } from '../sampleGenerator';
import { WaveletMatrix } from '../waveletMatrix';
import { buildChainSequence, computeChain, type ChainPlan } from './chainCore';
import {
  buildChainSourceMap,
  chainSourcesAt,
  reviewChainWindow,
  validateChainWindowQuery,
  type ChainSourceRef,
} from './chainReview';

type Slots = readonly [number[], number[], number[]];

/** 逐窗排序预言机：同值按合成位置升序排序 */
function oracleReview(slots: Slots, plan: ChainPlan, start: number, end: number, k: number) {
  const seq = buildChainSequence(slots, plan);
  const ordered = seq
    .slice(start, end)
    .map((value, offset) => ({ value, position: start + offset }))
    .sort((a, b) => a.value - b.value || a.position - b.position);
  const picked = ordered[k - 1];
  return {
    windowLength: end - start,
    kthValue: picked.value,
    lessCount: ordered.filter((item) => item.value < picked.value).length,
    equalCount: ordered.filter((item) => item.value === picked.value).length,
    position: picked.position,
  };
}

function expectSourceMapsEqual(slots: Slots, plan: ChainPlan): void {
  const seq = buildChainSequence(slots, plan);
  const mapped = buildChainSourceMap(slots, plan);
  expect(mapped).toHaveLength(plan.mergedLength);
  for (let position = 0; position < plan.mergedLength; position++) {
    expect(chainSourcesAt(slots, plan, position)).toEqual(mapped[position]);
    expect(mapped[position].length).toBeGreaterThanOrEqual(1);
    expect(mapped[position].length).toBeLessThanOrEqual(3);
    for (const source of mapped[position]) {
      expect(source.value).toBe(seq[position]);
    }
  }
}

function expectReviewMatchesOracle(
  slots: Slots,
  plan: ChainPlan,
  start: number,
  end: number,
  k: number,
): void {
  const want = oracleReview(slots, plan, start, end, k);
  const got = reviewChainWindow({ slots, plan, query: { start, end, k } });
  expect(got.kind).toBe('review');
  if (got.kind !== 'review') return;
  expect(got).toMatchObject(want);
  expect(got.sources).toEqual(chainSourcesAt(slots, plan, got.position));
}

describe('ChainReview：直接合成 + 逐窗排序预言机', () => {
  it('随机短链：所有非空子窗口与所有 k 均与排序预言机一致', () => {
    const rng = mulberry32(0xc4a10001);
    let solved = 0;
    for (let trial = 0; trial < 240 && solved < 80; trial++) {
      const slots: [number[], number[], number[]] = [[], [], []];
      for (let s = 0; s < 3; s++) {
        const len = 1 + Math.floor(rng() * 8);
        for (let i = 0; i < len; i++) slots[s].push(Math.floor(rng() * 5));
      }
      const plan = computeChain(slots);
      if (!plan) continue;
      solved++;
      expectSourceMapsEqual(slots, plan);

      const seq = buildChainSequence(slots, plan);
      for (let start = 0; start < seq.length; start++) {
        for (let end = start + 1; end <= seq.length; end++) {
          for (let k = 1; k <= end - start; k++) {
            expectReviewMatchesOracle(slots, plan, start, end, k);
          }
        }
      }
    }
    expect(solved).toBeGreaterThan(30);
  });

  it('随机数据：kthPosition 在任意子区间与排序后原位置完全一致', () => {
    const rng = mulberry32(0xc4a10003);
    for (let trial = 0; trial < 80; trial++) {
      const values = Array.from({ length: 1 + Math.floor(rng() * 30) }, () =>
        Math.floor(rng() * 8),
      );
      const wm = new WaveletMatrix(values);
      for (let start = 0; start < values.length; start++) {
        for (let end = start + 1; end <= values.length; end++) {
          const sorted = values
            .slice(start, end)
            .map((value, offset) => ({ value, position: start + offset }))
            .sort((a, b) => a.value - b.value || a.position - b.position);
          for (let k = 1; k <= end - start; k++) {
            expect(wm.kthPosition(start, end, k)).toEqual({
              value: sorted[k - 1].value,
              position: sorted[k - 1].position,
            });
            const value = sorted[k - 1].value;
            expect(wm.countLess(start, end, value)).toBe(
              sorted.filter((item) => item.value < value).length,
            );
            expect(wm.countEqual(start, end, value)).toBe(
              sorted.filter((item) => item.value === value).length,
            );
          }
        }
      }
    }
  });

  it('0/65535 边界值与成片重复值：countLess/countEqual 与 kthPosition 精确', () => {
    const wm = new WaveletMatrix([65535, 65535, 0, 0, 1, 65535]);
    expect(wm.countLess(0, 6, 0)).toBe(0);
    expect(wm.countEqual(0, 6, 0)).toBe(2);
    expect(wm.countEqual(0, 6, 65535)).toBe(3);
    expect(wm.kthPosition(0, 6, 1)).toEqual({ value: 0, position: 2 });
    expect(wm.kthPosition(0, 6, 2)).toEqual({ value: 0, position: 3 });
    expect(wm.kthPosition(0, 6, 4)).toEqual({ value: 65535, position: 0 });
    expect(wm.kthPosition(0, 6, 6)).toEqual({ value: 65535, position: 5 });
  });

  it('窗口边界：单元素、全窗口、首尾半开坐标及 k 两端', () => {
    const slots: [number[], number[], number[]] = [
      [9, 1, 2],
      [2, 3],
      [3, 8],
    ];
    const plan = computeChain(slots)!;
    expect(plan.mergedLength).toBe(5);
    const seq = buildChainSequence(slots, plan);
    for (let i = 0; i < seq.length; i++) {
      expectReviewMatchesOracle(slots, plan, i, i + 1, 1);
    }
    expectReviewMatchesOracle(slots, plan, 0, seq.length, 1);
    expectReviewMatchesOracle(slots, plan, 0, seq.length, seq.length);
    expectReviewMatchesOracle(slots, plan, 1, 4, 1);
    expectReviewMatchesOracle(slots, plan, 1, 4, 3);
  });

  it('非法半开窗口和 k 返回有界错误，不返回位置或来源证据', () => {
    const slots: [number[], number[], number[]] = [
      [9, 1, 2],
      [2, 3],
      [3, 8],
    ];
    const plan = computeChain(slots)!;
    expect(validateChainWindowQuery(-1, 2, 1, plan.mergedLength)).toHaveLength(1);
    expect(validateChainWindowQuery(0, plan.mergedLength + 1, 1, plan.mergedLength)).toHaveLength(1);
    expect(validateChainWindowQuery(2, 2, 1, plan.mergedLength).length).toBeGreaterThanOrEqual(1);
    expect(validateChainWindowQuery(0, 2, 3, plan.mergedLength)).toHaveLength(1);

    const got = reviewChainWindow({ slots, plan, query: { start: 0, end: 2, k: 3 } });
    expect(got.kind).toBe('error');
  });
});

describe('ChainReview：接缝来源证据与重叠去重', () => {
  it('第一道接缝位置列出两个槽位的原始下标，统计中仍只算一次', () => {
    // A→B→C，合成 [9,1,2,3,8]，位置 2 是 A/B 接缝
    const slots: [number[], number[], number[]] = [
      [9, 1, 2],
      [2, 3],
      [3, 8],
    ];
    const plan = computeChain(slots)!;
    const sources = chainSourcesAt(slots, plan, 2);
    const expected: ChainSourceRef[] = [
      { slot: 0, originalIndex: 2, value: 2 },
      { slot: 1, originalIndex: 0, value: 2 },
    ];
    expect(sources).toEqual(expected);

    // [2,4)=[2,3] 长度为 2，而非 4 个重叠原始读数
    const got = reviewChainWindow({ slots, plan, query: { start: 2, end: 4, k: 1 } });
    expect(got).toMatchObject({
      kind: 'review',
      windowLength: 2,
      kthValue: 2,
      lessCount: 0,
      equalCount: 1,
      position: 2,
    });
  });

  it('第二道接缝位置列出合成段与末份槽位；重叠读数仍只计一次', () => {
    const slots: [number[], number[], number[]] = [
      [9, 1, 2],
      [2, 3],
      [3, 8],
    ];
    const plan = computeChain(slots)!;
    // 位置 3 是 S=[9,1,2,3] 与 C=[3,8] 的第二道接缝
    expect(chainSourcesAt(slots, plan, 3)).toEqual([
      { slot: 1, originalIndex: 1, value: 3 },
      { slot: 2, originalIndex: 0, value: 3 },
    ]);
    const got = reviewChainWindow({ slots, plan, query: { start: 2, end: 5, k: 2 } });
    expect(got).toMatchObject({
      kind: 'review',
      windowLength: 3,
      kthValue: 3,
      lessCount: 1,
      equalCount: 1,
      position: 3,
    });
  });

  it('第二道接缝跨越第一道接缝：同一合成位置列出三份槽位的原始下标', () => {
    // A=[0,1,2]，B=[1,2,3,4]，C=[0,1,2,3,4,9]
    // A→B 重叠 [1,2]；S=[0,1,2,3,4]→C 重叠整个 S（5 条），
    // 第二道接缝回跨第一道，合成仍为 [0,1,2,3,4,9]。
    const slots: [number[], number[], number[]] = [
      [0, 1, 2],
      [1, 2, 3, 4],
      [0, 1, 2, 3, 4, 9],
    ];
    const plan = computeChain(slots)!;
    expect(plan.overlap1).toBe(2);
    expect(plan.overlap2).toBe(5);
    expect(buildChainSequence(slots, plan)).toEqual([0, 1, 2, 3, 4, 9]);

    expect(chainSourcesAt(slots, plan, 0)).toEqual([
      { slot: 0, originalIndex: 0, value: 0 },
      { slot: 2, originalIndex: 0, value: 0 },
    ]);
    expect(chainSourcesAt(slots, plan, 1)).toEqual([
      { slot: 0, originalIndex: 1, value: 1 },
      { slot: 1, originalIndex: 0, value: 1 },
      { slot: 2, originalIndex: 1, value: 1 },
    ]);

    const got = reviewChainWindow({ slots, plan, query: { start: 0, end: 3, k: 2 } });
    expect(got).toMatchObject({
      kind: 'review',
      windowLength: 3,
      kthValue: 1,
      lessCount: 1,
      equalCount: 1,
      position: 1,
    });
    if (got.kind === 'review') {
      expect(got.sources.map((s) => s.slot)).toEqual([0, 1, 2]);
    }
  });

  it('独立来源映射逐位置覆盖随机方案，且所有证据读数值等于合成值', () => {
    const rng = mulberry32(0xc4a10002);
    for (let trial = 0; trial < 100; trial++) {
      const slots: [number[], number[], number[]] = [[], [], []];
      for (let s = 0; s < 3; s++) {
        const len = 1 + Math.floor(rng() * 7);
        for (let i = 0; i < len; i++) slots[s].push(Math.floor(rng() * 4));
      }
      const plan = computeChain(slots);
      if (plan) expectSourceMapsEqual(slots, plan);
    }
  });
});

describe('ChainReview：原查询索引长度闸门', () => {
  it('合成长度超过 READINGS_MAX 时只禁用复核，不否定传入的合法拼接', () => {
    const slots: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] = [
      { length: 1 },
      { length: 1 },
      { length: 1 },
    ];
    const plan: ChainPlan = { order: [0, 1, 2], overlap1: 0, overlap2: 0, mergedLength: READINGS_MAX + 1 };
    const got = reviewChainWindow({ slots, plan, query: { start: 0, end: 1, k: 1 } });
    expect(got.kind).toBe('disabled');
    if (got.kind === 'disabled') {
      expect(got.reason).toContain(String(READINGS_MAX));
    }
  });
});
