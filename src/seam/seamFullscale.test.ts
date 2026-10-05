import { describe, expect, it } from 'vitest';
import { computeSeamOverlap, createSeamMatcher } from './seamCore';
import { ManualScheduler, SeamStore } from './seamStore';
import { mulberry32 } from '../sampleGenerator';

/**
 * 满规模确定性验收：双侧各 200000 条读数。
 *
 * 重叠长度 K 通过构造精确锁定（不依赖被测实现反推）：
 * - left 只含 0..65534，right[K] 置为 65535；
 * - 任何长度 > K 的「后缀 ≡ 前缀」都要求 right[K] 与 left 中某元素相等，
 *   而 65535 在 left 中不存在，故重叠至多为 K；
 * - right[0..K) 逐条复制自 left[N-K..N)，故重叠至少为 K。
 * 线性性能由两道锁保证：处理元素总数恰为 (M-1)+N（确定性），
 * 以及挂钟时间远低于任何平方级算法（1 秒预算，实际为毫秒级）。
 */
const N = 200_000;
const M = 200_000;
const TRUNCATOR = 65535;

function buildPair(K: number, seed: number): { left: number[]; right: number[] } {
  const rng = mulberry32(seed);
  const left = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    left[i] = Math.floor(rng() * TRUNCATOR); // 0..65534，刻意排除 65535
  }
  const right = new Array<number>(M);
  for (let j = 0; j < M; j++) {
    right[j] = Math.floor(rng() * TRUNCATOR);
  }
  for (let j = 0; j < K; j++) {
    right[j] = left[N - K + j]; // 植入长度为 K 的接缝
  }
  if (K < M) {
    right[K] = TRUNCATOR; // 截断器：杜绝任何更长的匹配
  }
  return { left, right };
}

describe('接缝满规模验收（双侧各 20 万条）', () => {
  it('植入 K=123456 的重叠：长度精确、工作量线性、1 秒内完成', () => {
    const K = 123_456;
    const { left, right } = buildPair(K, 0x5ea50001);

    const t0 = performance.now();
    const matcher = createSeamMatcher(left, right);
    while (!matcher.step(65_536)) {
      // 大预算分片推进
    }
    const elapsed = performance.now() - t0;

    expect(matcher.overlap()).toBe(K);
    // 线性工作量的确定性证据：不多不少，恰好 (M-1)+N 个元素
    expect(matcher.processed).toBe(M - 1 + N);
    expect(elapsed).toBeLessThan(1000);
  });

  it('K=0：满规模零重叠', () => {
    const { left, right } = buildPair(0, 0x5ea50002);
    expect(computeSeamOverlap(left, right)).toBe(0);
  });

  it('K=M：right 整体等于 left 后缀（两侧全同），重叠为 200000', () => {
    const rng = mulberry32(0x5ea50003);
    const left = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      left[i] = Math.floor(rng() * 65_536);
    }
    const right = left.slice();
    expect(computeSeamOverlap(left, right)).toBe(M);
  });

  it('经 SeamStore 分片调度：正确长度、去重拼接长度与两侧上下文', () => {
    const K = 123_456;
    const { left, right } = buildPair(K, 0x5ea50001);
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 4096);

    store.readySlot('left', 'front-200k.json', left);
    store.readySlot('right', 'back-200k.json', right);
    expect(store.getState().phase).toBe('matching');

    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('seam');
    const r = state.result!;
    expect(r.leftFileName).toBe('front-200k.json');
    expect(r.rightFileName).toBe('back-200k.json');
    expect(r.overlap).toBe(K);
    expect(r.mergedCount).toBe(N + M - K);
    expect(r.leftCount).toBe(N);
    expect(r.rightCount).toBe(M);
    // 上下文：前段末尾 8 条、后段开头 8 条；接缝区为 left[N-K..N) ≡ right[0..K)，
    // 因此 right 开头 8 条对应 left[N-K..N-K+8)
    expect(r.leftTail).toEqual(left.slice(-8));
    expect(r.rightHead).toEqual(right.slice(0, 8));
    expect(r.rightHead).toEqual(left.slice(N - K, N - K + 8));
  });

  it('满规模替换：旧任务作废后新配对仍在线性时间内给出正确结论', () => {
    const K1 = 100_000;
    const K2 = 150_000;
    const pair1 = buildPair(K1, 0x5ea50004);
    const pair2 = buildPair(K2, 0x5ea50005);
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 8192);

    store.readySlot('left', 'L1.json', pair1.left);
    store.readySlot('right', 'R1.json', pair1.right);
    // 推进少量分片后整体替换两侧
    scheduler.runNext();
    store.readySlot('left', 'L2.json', pair2.left);
    store.readySlot('right', 'R2.json', pair2.right);

    scheduler.runAll();
    const state = store.getState();
    expect(state.result!.leftFileName).toBe('L2.json');
    expect(state.result!.rightFileName).toBe('R2.json');
    expect(state.result!.overlap).toBe(K2);
    expect(state.result!.mergedCount).toBe(N + M - K2);
  });
});
