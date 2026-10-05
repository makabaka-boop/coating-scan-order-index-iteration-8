import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '../seam/seamStore';
import { ChainStore, type ChainSolution } from './chainStore';

/**
 * 跨接缝窗口一次性复核 · 状态存储测试。
 *
 * 关键不变量：证据绑定产生它的拼接方案——替换任一槽位、匹配失败或
 * 切换方案立即撤销旧证据（state.review 随 result 一起清空），绝不能
 * 拿新序列配旧位置；非法窗口不入状态、不顶掉既有证据；超容量只禁用
 * 复核，不废弃合法拼接。数值正确性本身在 chainReview.test.ts 由
 * 逐窗排序 + 独立来源映射预言机穷举，此处只核对绑定/撤销/闸门。
 */

/** 三份可拼接样本：A→B→C，合成 [9,1,2,3,8]，o1=o2=1 */
const SAMPLE = {
  a: [9, 1, 2],
  b: [2, 3],
  c: [3, 8],
} as const;

function chainedStore(scheduler: ManualScheduler, budget?: number): ChainStore {
  const store = new ChainStore(scheduler, budget);
  store.readySlot('A', 'a.json', [...SAMPLE.a]);
  store.readySlot('B', 'b.json', [...SAMPLE.b]);
  store.readySlot('C', 'c.json', [...SAMPLE.c]);
  scheduler.runAll();
  expect(store.getState().phase).toBe('chained');
  return store;
}

describe('ChainStore：跨接缝窗口复核', () => {
  it('成功复核写入绑定证据：值、计数、位置与来源（槽位 + 原始下标）', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    const out = store.reviewWindow({ start: 0, end: 5, k: 2 });
    expect(out.kind).toBe('evidence');

    const state = store.getState();
    expect(state.review).not.toBeNull();
    const bound = state.review!;
    // 绑定产生它的三槽版本与任务身份
    expect(bound.taskId).toBe(1);
    expect(bound.versionA).toBe(state.versions.A);
    expect(bound.versionB).toBe(state.versions.B);
    expect(bound.versionC).toBe(state.versions.C);

    const e = bound.evidence;
    expect(e.value).toBe(2); // [9,1,2,3,8] 第 2 小
    expect(e.lessCount).toBe(1);
    expect(e.equalCount).toBe(1);
    expect(e.position).toBe(2); // 合成位置 2 恰为第一道接缝重叠（B 下标 0 同证）
    const keys = e.sources.map((s) => s.slotIndex);
    expect(keys).toContain(0); // 槽 A（位置 2 是 A 原始下标 2）
    expect(keys).toContain(1); // 槽 B（B[0]=2 是接缝一重叠）
    expect(keys).not.toContain(2);
  });

  it('整窗第 1 小来自 A 中部，证据只有单槽', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    const out = store.reviewWindow({ start: 0, end: 5, k: 1 });
    expect(out.kind).toBe('evidence');
    if (out.kind === 'evidence') {
      expect(out.value).toBe(1);
      expect(out.position).toBe(1);
      expect(out.sources).toEqual([{ slotIndex: 0, originalIndex: 1 }]);
    }
  });

  it('非法窗口返回 error 且不产生/不顶掉证据', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);

    const bad = store.reviewWindow({ start: 0, end: 5, k: 9 });
    expect(bad.kind).toBe('error');
    expect(store.getState().review).toBeNull();

    store.reviewWindow({ start: 0, end: 5, k: 1 });
    expect(store.getState().review).not.toBeNull();

    const bad2 = store.reviewWindow({ start: 4, end: 1, k: 1 });
    expect(bad2.kind).toBe('error');
    // 既有证据原样保留（只是参数非法，方案未变）
    expect(store.getState().review!.evidence.value).toBe(1);
  });

  it('再次成功复核原子替换旧证据（同一方案的一次性窗口可改参重提）', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    store.reviewWindow({ start: 0, end: 5, k: 1 });
    expect(store.getState().review!.evidence.value).toBe(1);

    store.reviewWindow({ start: 0, end: 5, k: 5 });
    const state = store.getState();
    expect(state.review!.evidence.value).toBe(9);
    expect(state.review!.evidence.k).toBe(5);
  });

  it('clearReview 只清证据，不影响拼接结论与预览', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    store.reviewWindow({ start: 0, end: 5, k: 1 });
    store.clearReview();
    const state = store.getState();
    expect(state.review).toBeNull();
    expect(state.phase).toBe('chained');
    const r = state.result as ChainSolution;
    expect(r.head).toEqual([9, 1, 2, 3, 8]);
    expect(r.tail).toEqual([9, 1, 2, 3, 8]);
  });
});

describe('ChainStore：复核证据随方案替换立即撤销', () => {
  it('替换任一槽位：旧证据随结论同步撤销，新方案复核用新序列', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    store.reviewWindow({ start: 0, end: 5, k: 2 });
    expect(store.getState().review).not.toBeNull();

    // 替换槽 B：旧结论与旧证据立即撤销，进入匹配中
    store.readySlot('B', 'b2.json', [7, 7, 7]);
    const mid = store.getState();
    expect(mid.review).toBeNull();
    expect(mid.result).toBeNull();

    scheduler.runAll();
    const done = store.getState();
    expect(done.phase).toBe('no-chain');
    expect(done.review).toBeNull();

    // 无成立方案时复核被拒绝，不得回写任何证据
    const rejected = store.reviewWindow({ start: 0, end: 2, k: 1 });
    expect(rejected.kind).toBe('error');
    expect(store.getState().review).toBeNull();
  });

  it('匹配失败（槽位错误）撤销旧证据，其余槽位与预览不再残留', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    store.reviewWindow({ start: 0, end: 5, k: 1 });

    store.failSlot('C', 'bad.json', ['readings[0]：必须是整数']);
    const state = store.getState();
    expect(state.review).toBeNull();
    expect(state.result).toBeNull();
    expect(state.phase).toBe('partial');
  });

  it('取消任一槽位：证据撤销；重新三槽成立后证据不复活，必须重新复核', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    store.reviewWindow({ start: 0, end: 5, k: 1 });

    store.clearSlot('B');
    expect(store.getState().review).toBeNull();

    store.readySlot('B', 'b.json', [...SAMPLE.b]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('chained');
    // 即便仍是同样三份文件，这是一次新方案，旧证据不复活
    expect(store.getState().review).toBeNull();

    const again = store.reviewWindow({ start: 0, end: 5, k: 1 });
    expect(again.kind).toBe('evidence');
    expect(store.getState().review).not.toBeNull();
  });

  it('方案切换（同三槽但内容改变使最优顺序改变）：旧位置证据必须撤销', () => {
    const scheduler = new ManualScheduler();
    const store = chainedStore(scheduler);
    const first = store.reviewWindow({ start: 0, end: 5, k: 2 });
    expect(first.kind).toBe('evidence');
    if (first.kind === 'evidence') {
      expect(first.position).toBe(2);
    }

    // 换成另一条可拼接链：A2=[0,9,1,2] B=[2,3] C=[3,8]，合成 [0,9,1,2,3,8]
    store.readySlot('A', 'a2.json', [0, 9, 1, 2]);
    scheduler.runAll();
    const state = store.getState();
    expect(state.review).toBeNull(); // 新序列不得配旧位置
    const r = state.result as ChainSolution;
    expect(r.mergedCount).toBe(6);

    const out = store.reviewWindow({ start: 0, end: 6, k: 2 });
    if (out.kind === 'evidence') {
      expect(out.value).toBe(1);
      expect(out.position).toBe(2); // 新合成序列的位置，与旧方案无关
    } else {
      throw new Error('新方案复核应成功');
    }
  });

  it('在途分片期间替换槽位：旧任务完成回调不得带出旧证据', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 1);
    store.readySlot('A', 'a.json', [...SAMPLE.a]);
    store.readySlot('B', 'b.json', [...SAMPLE.b]);
    store.readySlot('C', 'c.json', [...SAMPLE.c]);
    scheduler.runNext(); // 旧任务推进一个分片
    store.reviewWindow({ start: 0, end: 5, k: 1 }); // 未 chained，被拒
    expect(store.getState().review).toBeNull();

    store.readySlot('A', 'a2.json', [7, 7, 7]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('no-chain');
    expect(store.getState().review).toBeNull();
  });
});

describe('ChainStore：复核容量闸门（不废弃合法拼接）', () => {
  /** 唯一合法链构造：互不相交值域 + 植入重叠；合成长度 = 3n−2o */
  function triple(n: number, o: number): [number[], number[], number[]] {
    const x = Array.from({ length: n }, (_, i) => 1000 + ((i * 7) % 100));
    const y = Array.from({ length: n }, (_, i) => 2000 + ((i * 13) % 100));
    const z = Array.from({ length: n }, (_, i) => 3000 + ((i * 17) % 100));
    for (let j = 0; j < o; j++) y[j] = x[n - o + j];
    for (let j = 0; j < o; j++) z[j] = y[n - o + j];
    return [x, y, z];
  }

  it('合成长度 200001：拼接仍 chained 且预览在，仅复核 unavailable', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 1 << 20);
    const [x, y, z] = triple(70_001, 5_001);
    store.readySlot('A', 'a.json', x);
    store.readySlot('B', 'b.json', y);
    store.readySlot('C', 'c.json', z);
    scheduler.runAll();

    const state = store.getState();
    expect(state.phase).toBe('chained');
    const r = state.result as ChainSolution;
    expect(r.mergedCount).toBe(200_001);
    expect(r.head.length).toBeGreaterThan(0);
    expect(r.tail.length).toBeGreaterThan(0);

    const out = store.reviewWindow({ start: 0, end: 10, k: 1 });
    expect(out.kind).toBe('unavailable');
    expect(state.review).toBeNull(); // 禁用不产生证据
    // 拼接结论仍然完整保留
    expect(store.getState().phase).toBe('chained');
  });

  it('合成长度恰为 200000：复核可用且证据落状态', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 1 << 20);
    const [x, y, z] = triple(70_000, 5_000);
    store.readySlot('A', 'a.json', x);
    store.readySlot('B', 'b.json', y);
    store.readySlot('C', 'c.json', z);
    scheduler.runAll();
    const r = store.getState().result as ChainSolution;
    expect(r.mergedCount).toBe(200_000);

    const out = store.reviewWindow({ start: 0, end: 200_000, k: 1 });
    expect(out.kind).toBe('evidence');
    expect(store.getState().review).not.toBeNull();
  });
});
