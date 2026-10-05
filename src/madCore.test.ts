import { describe, expect, it } from 'vitest';
import { WaveletMatrix } from './waveletMatrix';
import { madBySort } from './oracle';
import { analyze } from './analyze';
import { READINGS_MAX, VALUE_MAX } from './types';

/** 对所有合法 [start,end) 穷举：较低中位数 + 偏差总量 对直接排序预言机 */
function exhaustivelyCompareMad(readings: number[]) {
  const wm = new WaveletMatrix(readings, { withSums: true });
  const n = readings.length;
  for (let start = 0; start < n; start++) {
    for (let end = start + 1; end <= n; end++) {
      const got = wm.medianDeviation(start, end);
      const want = madBySort(readings, start, end);
      // 较低中位数必须同时与第 ⌈len/2⌉ 小查询一致（复用同一索引语义）
      const lowerMedianKth = wm.kth(start, end, ((end - start + 1) >> 1));
      if (
        got.median !== want.median ||
        got.deviationTotal !== want.deviationTotal ||
        got.median !== lowerMedianKth
      ) {
        throw new Error(
          `readings=${JSON.stringify(readings)} [${start},${end}): ` +
            `got {median:${got.median},total:${got.deviationTotal}}, ` +
            `want {median:${want.median},total:${want.deviationTotal}}, ` +
            `kth-lower=${lowerMedianKth}`,
        );
      }
      // 精确整数：任何展示舍入 / 浮点误差都不允许
      if (!Number.isInteger(got.deviationTotal) || got.deviationTotal < 0) {
        throw new Error(`偏差总量必须是非负精确整数：${got.deviationTotal}`);
      }
    }
  }
}

describe('WaveletMatrix.medianDeviation 对直接排序+逐项求和预言机', () => {
  it('单元素窗口：中位数即唯一读数，总量为 0', () => {
    exhaustivelyCompareMad([0]);
    exhaustivelyCompareMad([65535]);
    const wm = new WaveletMatrix([0, 65535], { withSums: true });
    expect(wm.medianDeviation(0, 1)).toEqual({ median: 0, deviationTotal: 0 });
    expect(wm.medianDeviation(1, 2)).toEqual({ median: 65535, deviationTotal: 0 });
  });

  it('全相等：任意窗口总量为 0、中位数为该值', () => {
    exhaustivelyCompareMad([7, 7, 7, 7, 7]);
    exhaustivelyCompareMad(new Array(30).fill(42000));
  });

  it('偶数长取较低中位数（两中位值不等时取小者）', () => {
    // [1,2,3,100] 排序后两中位值为 2 与 3，较低中位数 = 2；总量 = 1+0+1+98 = 100
    const wm = new WaveletMatrix([1, 2, 3, 100], { withSums: true });
    expect(wm.medianDeviation(0, 4)).toEqual({ median: 2, deviationTotal: 100 });
    // 预言机穷举再次确认所有子窗口
    exhaustivelyCompareMad([1, 2, 3, 100]);
    // 两中位值跨过 16 位中部分界，验证高低位切分正确
    exhaustivelyCompareMad([31000, 31001, 40000, 40001, 0, 65535]);
  });

  it('重复值混合：含 0、65535、交错重复，重复读数只算一次偏差', () => {
    exhaustivelyCompareMad([3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]);
    exhaustivelyCompareMad([65535, 0, 0, 65535, 1, 0, 65535]);
    exhaustivelyCompareMad([2, 2, 1, 1, 2, 2, 1, 1]);
  });

  it('首尾窗口与随机小样本：全部子区间穷举', () => {
    exhaustivelyCompareMad([10, 50, 20, 40, 30, 60, 0, 65535]);
    let seed = 777;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rng() * 18);
      const vals: number[] = [];
      for (let i = 0; i < n; i++) {
        // 大部分收窄制造重复，小概率打满值域
        vals.push(rng() < 0.2 ? (rng() < 0.5 ? 0 : 65535) : Math.floor(rng() * 6));
      }
      exhaustivelyCompareMad(vals);
    }
  });

  it('未带值前缀和构造时，第 k 小照常、偏差查询显式报错而非悄悄算错', () => {
    const wm = new WaveletMatrix([1, 2, 3, 100]);
    expect(wm.kth(0, 4, 2)).toBe(2);
    expect(() => wm.medianDeviation(0, 4)).toThrow(/withSums/);
  });

  it('最大合法总量：20 万长窗口一半 0 一半 65535（偶数长，m*65535）', () => {
    const n = READINGS_MAX;
    const readings = new Array<number>(n);
    for (let i = 0; i < n; i++) readings[i] = i & 1 ? VALUE_MAX : 0;
    const wm = new WaveletMatrix(readings, { withSums: true });

    const m = n >> 1;
    const expected = m * VALUE_MAX; // 6_553_500_000
    const got = wm.medianDeviation(0, n);
    expect(got.median).toBe(0); // 排序后第 m 小（较低中位数）为 0
    expect(got.deviationTotal).toBe(expected);
    expect(got.deviationTotal).toBe(madBySort(readings, 0, n).deviationTotal);
    // 该值已超 Int32/uint32 但远低于 2^53，必须仍是精确整数（无溢出、无科学计数舍入）
    expect(Number.isSafeInteger(got.deviationTotal)).toBe(true);
    expect(got.deviationTotal.toString()).toBe('6553500000');

    // 奇数长 199999：99999 个 0 + 100000 个 65535，较低中位数（第 100000 小）
    // 为 65535，总量 = 99999*65535
    const oddReadings: number[] = new Array(n - 1);
    for (let i = 0; i < 99_999; i++) oddReadings[i] = 0;
    for (let i = 99_999; i < n - 1; i++) oddReadings[i] = VALUE_MAX;
    const wm2 = new WaveletMatrix(oddReadings, { withSums: true });
    const oddGot = wm2.medianDeviation(0, n - 1);
    expect(oddGot.median).toBe(65535);
    expect(oddGot.deviationTotal).toBe(99999 * VALUE_MAX);
    expect(oddGot.deviationTotal).toBe(madBySort(oddReadings, 0, n - 1).deviationTotal);
  });
});

describe('analyze：可选中位绝对偏差总量', () => {
  const readings = [5, 1, 4, 2, 8, 3, 7, 6];
  const queries = [
    { start: 0, end: 8, k: 1 },
    { start: 0, end: 8, k: 8 },
    { start: 2, end: 5, k: 2 },
    { start: 0, end: 1, k: 1 },
    { start: 7, end: 8, k: 1 },
    { start: 0, end: 4, k: 2 },
  ];

  it('未启用（默认/显式 false）：结果形状与字段逐位保持原样', () => {
    const def = analyze({ readings, queries });
    const off = analyze({ readings, queries }, { includeMad: false });
    expect(def.ok).toBe(off.ok);
    expect(def.answers).toEqual(off.answers);
    expect(def.sum).toBe(off.sum);
    expect(def.digest).toBe(off.digest);
    expect(def.queryCount).toBe(off.queryCount);
    expect(def.errors).toEqual(off.errors);
    expect(def.answers).toEqual([1, 8, 4, 5, 6, 2]);
    expect(def.madTotals).toBeUndefined();
    expect(def.madSum).toBeUndefined();
  });

  it('启用：按原查询顺序逐行给出总量，且不改变第 k 小答案与摘要', () => {
    const on = analyze({ readings, queries }, { includeMad: true });
    const off = analyze({ readings, queries });
    expect(on.ok).toBe(true);
    expect(on.answers).toEqual(off.answers);
    expect(on.sum).toBe(off.sum);
    expect(on.digest).toBe(off.digest);
    expect(on.madTotals).toBeDefined();
    expect(on.madTotals!.length).toBe(queries.length);

    const expectedTotals = queries.map((q) => madBySort(readings, q.start, q.end).deviationTotal);
    expect(on.madTotals).toEqual(expectedTotals);
    // 单元素窗口总量为 0
    expect(on.madTotals![3]).toBe(0);
    expect(on.madTotals![4]).toBe(0);
    // 逐行与较低中位数预言机核对
    queries.forEach((q, i) => {
      const wm = new WaveletMatrix(readings, { withSums: true });
      expect(on.madTotals![i]).toBe(wm.medianDeviation(q.start, q.end).deviationTotal);
    });
    // madSum 是逐行总和
    expect(on.madSum).toBe(expectedTotals.reduce((a, b) => a + b, 0));
    expect(Number.isSafeInteger(on.madSum!)).toBe(true);
  });

  it('queries 为空时启用也合法：空总量、madSum 为 0', () => {
    const r = analyze({ readings: [1, 2, 3], queries: [] }, { includeMad: true });
    expect(r.ok).toBe(true);
    expect(r.madTotals).toEqual([]);
    expect(r.madSum).toBe(0);
  });

  it('校验失败：不存在任何总量/答案，绝不与旧数据混用', () => {
    const r = analyze(
      { readings, queries: [{ start: 0, end: 99, k: 1 }] },
      { includeMad: true },
    );
    expect(r.ok).toBe(false);
    expect(r.answers).toEqual([]);
    expect(r.madTotals).toBeUndefined();
    expect(r.madSum).toBeUndefined();
    expect(r.queryCount).toBe(0);
  });
});
