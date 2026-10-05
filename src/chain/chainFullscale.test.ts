import { describe, expect, it } from 'vitest';
import { computeChain, createChainMatcher } from './chainCore';
import { ManualScheduler } from '../seam/seamStore';
import { ChainStore, type ChainSolution } from './chainStore';
import { mulberry32 } from '../sampleGenerator';

/**
 * 满规模确定性验收：三槽各 200000 条读数。
 *
 * 重叠长度 K1、K2 通过构造精确锁定（不依赖被测实现反推）：
 * - x 非重叠区取值为 [0,20000)，y 非重叠区为 [20000,40000)，z 非重叠区为
 *   [40000,60000)——三段非重叠区值域互不相交，未植入的方向上连 1 条
 *   重叠都不可能（末值与首值必不相等），与随机取值无关；
 * - x 末 K1 条 ≡ y 前 K1 条（植入）；更长重叠要求 x[N-K1-1]（值域
 *   [0,20000)）等于 y[K1]（值域 [20000,40000)），不可能，故 overlap(x,y) 恰为 K1；
 * - y 末 K2 条 ≡ z 前 K2 条（植入）；同理 overlap(y,z) 恰为 K2；
 * - K1 + K2 < N，y 的两处植入区互不相交，不会经 y 间接产生 x→z 的重叠；
 * - 唯一合法顺序为 (x,y,z)：排列 (y,z,x) 接缝一合法但接缝二为 0，
 *   其余四种顺序接缝一即为 0。
 *
 * 线性性能由两道锁保证：处理元素总数恰为下式（确定性），
 * 以及挂钟时间远低于任何平方级算法（2 秒预算，实际为毫秒级）。
 */
const N = 200_000;
const K1 = 100_000;
const K2 = 90_000;

function buildTriple(): { x: number[]; y: number[]; z: number[] } {
  const rng = mulberry32(0xc3a15ca1);
  const x = new Array<number>(N);
  const y = new Array<number>(N);
  const z = new Array<number>(N);
  for (let i = 0; i < N; i++) x[i] = Math.floor(rng() * 20_000); // [0,20000)
  for (let i = 0; i < N; i++) y[i] = 20_000 + Math.floor(rng() * 20_000); // [20000,40000)
  for (let i = 0; i < N; i++) z[i] = 40_000 + Math.floor(rng() * 20_000); // [40000,60000)
  for (let j = 0; j < K1; j++) y[j] = x[N - K1 + j]; // 植入接缝一：x 后缀 ≡ y 前缀
  for (let j = 0; j < K2; j++) z[j] = y[N - K2 + j]; // 植入接缝二：y 后缀 ≡ z 前缀
  return { x, y, z };
}

/** 期望的处理元素总数：6 次接缝一 + 两次物化 + 两次接缝二（其余排列接缝一即非法） */
const EXPECTED_PROCESSED =
  6 * (N - 1 + N) + // 六种顺序各一次接缝一
  (2 * N - K1) + // 排列 (x,y,z) 物化合成序列
  (N - 1 + (2 * N - K1)) + // 排列 (x,y,z) 接缝二
  (2 * N - K2) + // 排列 (y,z,x) 物化合成序列
  (N - 1 + (2 * N - K2)); // 排列 (y,z,x) 接缝二

describe('拼接链满规模验收（三槽各 20 万条）', () => {
  it('植入 K1/K2 的链：方案精确、工作量线性、2 秒内完成', () => {
    const { x, y, z } = buildTriple();

    const t0 = performance.now();
    const matcher = createChainMatcher([x, y, z]);
    while (!matcher.step(65_536)) {
      // 大预算分片推进
    }
    const elapsed = performance.now() - t0;

    const plan = matcher.best();
    expect(plan).not.toBeNull();
    expect([...plan!.order]).toEqual([0, 1, 2]);
    expect(plan!.overlap1).toBe(K1);
    expect(plan!.overlap2).toBe(K2);
    expect(plan!.mergedLength).toBe(3 * N - K1 - K2);
    // 线性工作量的确定性证据：不多不少，恰为期望的元素总数
    expect(matcher.processed).toBe(EXPECTED_PROCESSED);
    expect(elapsed).toBeLessThan(2000);
  });

  it('computeChain 同步入口与分片结果一致', () => {
    const { x, y, z } = buildTriple();
    const plan = computeChain([x, y, z]);
    expect(plan).not.toBeNull();
    expect([...plan!.order]).toEqual([0, 1, 2]);
    expect(plan!.overlap1).toBe(K1);
    expect(plan!.overlap2).toBe(K2);
  });

  it('三份互不接触（值域互不相交、无植入）：无解', () => {
    const rng = mulberry32(0xc3a15ca2);
    const x = Array.from({ length: N }, () => Math.floor(rng() * 20_000));
    const y = Array.from({ length: N }, () => 20_000 + Math.floor(rng() * 20_000));
    const z = Array.from({ length: N }, () => 40_000 + Math.floor(rng() * 20_000));
    expect(computeChain([x, y, z])).toBeNull();
  });

  it('经 ChainStore 分片调度：最终顺序、两道接缝、合成长度与合成预览', () => {
    const { x, y, z } = buildTriple();
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 65_536);

    store.readySlot('A', 'part-a.json', x);
    store.readySlot('B', 'part-b.json', y);
    store.readySlot('C', 'part-c.json', z);
    expect(store.getState().phase).toBe('matching');

    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('chained');
    const r = state.result as ChainSolution;
    expect(r.order).toEqual(['A', 'B', 'C']);
    expect(r.fileNames).toEqual(['part-a.json', 'part-b.json', 'part-c.json']);
    expect(r.counts).toEqual([N, N, N]);
    expect(r.overlap1).toBe(K1);
    expect(r.overlap2).toBe(K2);
    expect(r.mergedCount).toBe(3 * N - K1 - K2);
    // 合成预览：开头 8 条来自 x 开头，末尾 8 条来自 z 末尾
    expect(r.head).toEqual(x.slice(0, 8));
    expect(r.tail).toEqual(z.slice(N - 8));
  });

  it('满规模替换：旧任务作废后新组合仍在线性时间内给出正确结论', () => {
    const first = buildTriple();
    const second = buildTriple();
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 65_536);

    store.readySlot('A', 'a1.json', first.x);
    store.readySlot('B', 'b1.json', first.y);
    store.readySlot('C', 'c1.json', first.z);
    // 推进少量分片后整体替换三槽
    scheduler.runNext();
    store.readySlot('A', 'a2.json', second.x);
    store.readySlot('B', 'b2.json', second.y);
    store.readySlot('C', 'c2.json', second.z);

    scheduler.runAll();
    const state = store.getState();
    const r = state.result as ChainSolution;
    expect(r.kind).toBe('solution');
    expect(r.fileNames).toEqual(['a2.json', 'b2.json', 'c2.json']);
    expect(r.overlap1).toBe(K1);
    expect(r.overlap2).toBe(K2);
    expect(r.mergedCount).toBe(3 * N - K1 - K2);
  });
});
