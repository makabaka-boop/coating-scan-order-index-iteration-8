import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '../seam/seamStore';
import { CHAIN_SLOT_KEYS, ChainStore, type ChainSolution } from './chainStore';
import { computeChain } from './chainCore';
import { MAX_FILE_BYTES, formatByteSize } from '../types';

/** 构造合法文件 JSON 文本（契约要求 readings 与 queries 同时合法） */
function fileText(readings: number[], queries: unknown[] = []): string {
  return JSON.stringify({ readings, queries });
}

/** 可手动兑现/拒绝的 Promise，用于精确控制文件读取回调的到达时机 */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 立即兑现的微任务读取，模拟 file.text() */
function textOf(text: string): () => Promise<string> {
  return () => Promise.resolve(text);
}

/** 三份可拼接样本：A→B→C，接缝一重叠 1，接缝二重叠 1 */
const SAMPLE = {
  a: [9, 1, 2],
  b: [2, 3],
  c: [3, 8],
} as const;

describe('ChainStore：三槽位状态机', () => {
  it('空闲 → 部分就绪 → 匹配中 → 拼接成立，结果字段完整', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().result).toBeNull();

    store.readySlot('A', 'a.json', [...SAMPLE.a]);
    expect(store.getState().phase).toBe('partial');
    store.readySlot('C', 'c.json', [...SAMPLE.c]);
    expect(store.getState().phase).toBe('partial');
    expect(store.getState().result).toBeNull();

    store.readySlot('B', 'b.json', [...SAMPLE.b]);
    expect(store.getState().phase).toBe('matching');
    expect(scheduler.pending).toBeGreaterThan(0);

    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('chained');
    const r = state.result as ChainSolution;
    expect(r.kind).toBe('solution');
    expect(r.order).toEqual(['A', 'B', 'C']);
    expect(r.fileNames).toEqual(['a.json', 'b.json', 'c.json']);
    expect(r.counts).toEqual([3, 2, 2]);
    expect(r.overlap1).toBe(1);
    expect(r.overlap2).toBe(1);
    expect(r.mergedCount).toBe(3 + 2 + 2 - 1 - 1);
    // 合成预览：合成序列 [9,1,2,3,8] 不足 8 条，头尾各取全部
    expect(r.head).toEqual([9, 1, 2, 3, 8]);
    expect(r.tail).toEqual([9, 1, 2, 3, 8]);
    expect(state.taskSeq).toBe(1);
  });

  it('合成预览超过 8 条时只取开头/末尾各 8 条', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    const a = [1, 2, 3, 4, 5];
    const b = [4, 5, 6, 7, 8];
    const c = [7, 8, 9, 10, 11];
    store.readySlot('A', 'a.json', a);
    store.readySlot('B', 'b.json', b);
    store.readySlot('C', 'c.json', c);
    scheduler.runAll();
    const r = store.getState().result as ChainSolution;
    expect(r.kind).toBe('solution');
    // 合成序列：[1,2,3,4,5,6,7,8,9,10,11]
    expect(r.mergedCount).toBe(11);
    expect(r.head).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.tail).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('三份均有效但六种顺序均不合法：明确进入无合法顺序终态', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    store.readySlot('A', 'a.json', [1, 1]);
    store.readySlot('B', 'b.json', [2, 2]);
    store.readySlot('C', 'c.json', [3, 3]);
    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('no-chain');
    expect(state.result).not.toBeNull();
    expect(state.result!.kind).toBe('none');
    if (state.result!.kind === 'none') {
      expect(state.result!.fileNames).toEqual(['a.json', 'b.json', 'c.json']);
    }
  });

  it('并列最优经 store 裁定：取槽位名称 A→B→C 顺序最小者', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    // 三种顺序合成长度均为 4，字典序最小为 A→B→C
    store.readySlot('A', 'a.json', [1, 2]);
    store.readySlot('B', 'b.json', [2, 3]);
    store.readySlot('C', 'c.json', [3, 1]);
    scheduler.runAll();
    const r = store.getState().result as ChainSolution;
    expect(r.kind).toBe('solution');
    expect(r.order).toEqual(['A', 'B', 'C']);
    expect(r.mergedCount).toBe(4);
  });

  it('替换任一槽立即撤销旧结论并重算，新结果只反映新组合', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    store.readySlot('A', 'a.json', [...SAMPLE.a]);
    store.readySlot('B', 'b.json', [...SAMPLE.b]);
    store.readySlot('C', 'c.json', [...SAMPLE.c]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('chained');

    // 替换槽 B：结论同步撤销，立刻回到匹配中
    store.readySlot('B', 'b2.json', [7, 7, 7]);
    const mid = store.getState();
    expect(mid.result).toBeNull();
    expect(mid.phase).toBe('matching');

    scheduler.runAll();
    const done = store.getState();
    expect(done.result!.kind).toBe('none'); // 新 B 与 A/C 接不成链
    expect(done.phase).toBe('no-chain');
  });

  it('单槽失败只标记该槽且保留其余两槽，结论同步撤销', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    store.readySlot('A', 'a.json', [...SAMPLE.a]);
    store.readySlot('B', 'b.json', [...SAMPLE.b]);
    store.readySlot('C', 'c.json', [...SAMPLE.c]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('chained');

    store.failSlot('B', 'bad.json', ['readings[0]：必须是整数']);
    const state = store.getState();
    expect(state.result).toBeNull();
    expect(state.phase).toBe('partial');
    expect(state.slots.B.status).toBe('error');
    expect(state.slots.A.status).toBe('ready');
    expect(state.slots.C.status).toBe('ready');

    // 失败的槽位重新就绪后，三槽重新裁定
    store.readySlot('B', 'b.json', [...SAMPLE.b]);
    scheduler.runAll();
    const again = store.getState();
    expect(again.phase).toBe('chained');
    expect((again.result as ChainSolution).order).toEqual(['A', 'B', 'C']);
  });

  it('取消槽位：回到空槽、撤销结论、作废旧任务', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    store.readySlot('A', 'a.json', [...SAMPLE.a]);
    store.readySlot('B', 'b.json', [...SAMPLE.b]);
    store.readySlot('C', 'c.json', [...SAMPLE.c]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('chained');

    store.clearSlot('B');
    const state = store.getState();
    expect(state.result).toBeNull();
    expect(state.slots.B.status).toBe('empty');
    expect(state.phase).toBe('partial');
    expect(state.slots.A.status).toBe('ready');
    expect(state.slots.C.status).toBe('ready');

    // 全部取消后回到空闲
    store.clearSlot('A');
    store.clearSlot('C');
    expect(store.getState().phase).toBe('idle');
  });
});

describe('ChainStore：可控调度器交错，替换/取消/失败不回写旧结果', () => {
  it('匹配推进到一半时替换槽位：旧任务在下一调度点终止，结果只属于新组合', () => {
    const scheduler = new ManualScheduler();
    // 分片预算 1：六种顺序的接缝与物化需要大量分片，制造交错窗口
    const store = new ChainStore(scheduler, 1);
    store.readySlot('A', 'a.json', [9, 1, 2]);
    store.readySlot('B', 'b.json', [2, 3]);
    store.readySlot('C', 'c.json', [3, 8]);
    expect(store.getState().taskSeq).toBe(1);

    // 旧任务只推进一个分片，尚未完成
    expect(scheduler.runNext()).toBe(true);
    expect(store.getState().result).toBeNull();

    // 替换槽 C：旧任务作废，新任务排入队列（旧任务的后续分片仍在队列中）
    store.readySlot('C', 'c2.json', [4, 5]);
    expect(store.getState().taskSeq).toBe(2);
    expect(store.getState().result).toBeNull();

    scheduler.runAll();
    const state = store.getState();
    // 最终结果必须反映新组合 A/B/C2，而不是旧组合
    const want = computeChain([
      [9, 1, 2],
      [2, 3],
      [4, 5],
    ]);
    expect(want).toBeNull(); // A→B 可接，但 C2=[4,5] 接不上 → 无解
    expect(state.result!.kind).toBe('none');
    expect(state.phase).toBe('no-chain');
  });

  it('旧任务的完成分片晚到：队列中先于新任务执行，也不得覆盖当前状态', () => {
    const scheduler = new ManualScheduler();
    // 预算足够大：每个任务一个分片即可完成
    const store = new ChainStore(scheduler, 1 << 20);
    store.readySlot('A', 'a.json', [9, 1, 2]);
    store.readySlot('B', 'b.json', [2, 3]);
    store.readySlot('C', 'c.json', [3, 8]);
    // 旧任务的唯一分片已在队列中，但尚未执行
    expect(scheduler.pending).toBe(1);

    // 在旧分片执行前替换槽 A：新任务排在其后
    store.readySlot('A', 'a2.json', [7, 7, 7]);
    expect(scheduler.pending).toBe(2);

    scheduler.runAll();
    const state = store.getState();
    // 若缺少身份核验，旧分片会先提交旧组合的结论并阻塞新任务提交
    expect(state.result!.kind).toBe('none'); // 新 A=[7,7,7] 与 B/C 接不成链
    expect(state.taskSeq).toBe(2);
  });

  it('匹配进行中取消槽位：结论撤销、其余两槽保留，旧任务晚到分片不得回写', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 1);
    store.readySlot('A', 'a.json', [9, 1, 2]);
    store.readySlot('B', 'b.json', [2, 3]);
    store.readySlot('C', 'c.json', [3, 8]);

    // 推进一个分片后取消槽 B
    expect(scheduler.runNext()).toBe(true);
    store.clearSlot('B');

    const mid = store.getState();
    expect(mid.phase).toBe('partial');
    expect(mid.result).toBeNull();
    expect(mid.slots.B.status).toBe('empty');

    // 泵空队列：旧任务的剩余分片不得提交任何结论
    scheduler.runAll();
    const done = store.getState();
    expect(done.result).toBeNull();
    expect(done.phase).toBe('partial');
    expect(done.slots.A.status).toBe('ready');
    expect(done.slots.C.status).toBe('ready');
  });

  it('连续快速替换三个槽位：只有最后一组组合能留下结论', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 1 << 20);
    store.readySlot('A', 'a1.json', [1, 1, 1]);
    store.readySlot('B', 'b1.json', [2, 2, 2]);
    store.readySlot('C', 'c1.json', [3, 3, 3]);
    store.readySlot('A', 'a2.json', [9, 1, 2]);
    store.readySlot('B', 'b2.json', [2, 3]);
    store.readySlot('C', 'c2.json', [3, 8]);
    // 队列中积压了多个被作废任务的分片
    expect(scheduler.pending).toBeGreaterThan(1);

    scheduler.runAll();
    const state = store.getState();
    const r = state.result as ChainSolution;
    expect(r.kind).toBe('solution');
    expect(r.fileNames).toEqual(['a2.json', 'b2.json', 'c2.json']);
    expect(r.order).toEqual(['A', 'B', 'C']);
    expect(r.mergedCount).toBe(5);
    expect(state.phase).toBe('chained');
  });
});

describe('ChainStore：一次性跨接缝窗口复核', () => {
  function chainedStore(): { store: ChainStore; scheduler: ManualScheduler } {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    store.readySlot('A', 'a.json', [9, 1, 2]);
    store.readySlot('B', 'b.json', [2, 3]);
    store.readySlot('C', 'c.json', [3, 8]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('chained');
    return { store, scheduler };
  }

  it('返回第 k 小、小于/等于数量及按合成位置升序定位的全部来源证据', () => {
    const { store } = chainedStore();
    store.reviewWindow({ start: 2, end: 4, k: 1 });
    const state = store.getState();
    expect(state.review).toMatchObject({
      kind: 'review',
      start: 2,
      end: 4,
      k: 1,
      windowLength: 2,
      kthValue: 2,
      lessCount: 0,
      equalCount: 1,
      position: 2,
    });
    if (state.review?.kind === 'review') {
      expect(state.review.sources).toEqual([
        { slot: 0, originalIndex: 2, value: 2 },
        { slot: 1, originalIndex: 0, value: 2 },
      ]);
    }
    const result = state.result as ChainSolution;
    expect(result.reviewEnabled).toBe(true);
    expect(result.slotFileNames).toEqual(['a.json', 'b.json', 'c.json']);
  });

  it('非法查询保留旧拼接方案，只显示复核错误；成功复核替换旧复核', () => {
    const { store } = chainedStore();
    store.reviewWindow({ start: 2, end: 4, k: 1 });
    store.reviewWindow({ start: 0, end: 5, k: 99 });
    let state = store.getState();
    expect(state.result).not.toBeNull();
    expect(state.review?.kind).toBe('error');

    store.reviewWindow({ start: 0, end: 5, k: 1 });
    state = store.getState();
    expect(state.review).toMatchObject({ kind: 'review', kthValue: 1, position: 1 });
  });

  it('替换任一槽立即撤销旧证据，不能拿新序列配旧位置', () => {
    const { store, scheduler } = chainedStore();
    store.reviewWindow({ start: 2, end: 4, k: 1 });
    expect(store.getState().review).not.toBeNull();

    store.readySlot('B', 'b2.json', [7, 7, 7]);
    expect(store.getState().review).toBeNull();
    scheduler.runAll();
    expect(store.getState().review).toBeNull();
  });

  it('匹配失败或取消槽位也撤销旧复核证据', () => {
    const storeA = chainedStore().store;
    storeA.readySlot('B', 'bad-match.json', [4, 5]);
    expect(storeA.getState().review).toBeNull();

    const { store, scheduler } = chainedStore();
    store.reviewWindow({ start: 0, end: 5, k: 1 });
    store.clearSlot('A');
    expect(store.getState().review).toBeNull();
    scheduler.runAll();
    expect(store.getState().review).toBeNull();
  });

  it('合成长度超过原查询索引上限时仅禁用复核，合法拼接仍成立', () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 1 << 20);
    const overlap = 4000;
    const periodic = (length: number, base: number, span: number) =>
      Array.from({ length }, (_, i) => base + (i % span));
    const a = [
      ...periodic(70000 - overlap, 0, 100),
      ...periodic(overlap, 1000, 1000),
    ];
    const b = [
      ...periodic(overlap, 1000, 1000),
      ...periodic(70000 - overlap * 2, 3000, 1000),
      ...periodic(overlap, 5000, 1000),
    ];
    const c = [
      ...periodic(overlap, 5000, 1000),
      ...periodic(70000 - overlap, 7000, 1000),
    ];
    store.readySlot('A', 'a.json', a);
    store.readySlot('B', 'b.json', b);
    store.readySlot('C', 'c.json', c);
    scheduler.runAll();

    const state = store.getState();
    expect(state.phase).toBe('chained');
    const result = state.result as ChainSolution;
    expect(result.mergedCount).toBe(210000 - overlap * 2);
    expect(result.reviewEnabled).toBe(false);
    expect(result.reviewDisabledReason).toContain('200000');
    store.reviewWindow({ start: 0, end: 1, k: 1 });
    expect(store.getState().review).toBeNull();
  });
});

describe('ChainStore：本地 JSON 入口（整文件契约验证，只取 readings）', () => {
  it('合法文件进入槽位并触发裁定；queries 为空也合法', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    await store.loadFileIntoSlot('A', 'a.json', textOf(fileText([9, 1, 2])));
    await store.loadFileIntoSlot('B', 'b.json', textOf(fileText([2, 3])));
    scheduler.runAll();
    expect(store.getState().phase).toBe('partial');
    await store.loadFileIntoSlot('C', 'c.json', textOf(fileText([3, 8])));
    // 解析续体经调度器排队：泵出后槽位才就绪、裁定才完成
    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('chained');
    expect((state.result as ChainSolution).mergedCount).toBe(5);
  });

  it('JSON 语法错误：只标记该槽，保留其余两槽', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    await store.loadFileIntoSlot('A', 'ok.json', textOf(fileText([1, 2, 3])));
    await store.loadFileIntoSlot('B', 'bad.json', textOf('{ not json'));
    scheduler.runAll();
    const state = store.getState();
    expect(state.slots.A.status).toBe('ready');
    expect(state.slots.B.status).toBe('error');
    if (state.slots.B.status === 'error') {
      expect(state.slots.B.errors.join('\n')).toContain('JSON 语法错误');
    }
    expect(state.phase).toBe('partial');
  });

  it('契约错误按下标反馈：readings 越界与 queries 非法都整体拒绝', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    await store.loadFileIntoSlot('A', 'r.json', textOf(fileText([1, 2, 65536])));
    scheduler.runAll();
    let state = store.getState();
    expect(state.slots.A.status).toBe('error');
    if (state.slots.A.status === 'error') {
      expect(state.slots.A.errors.join('\n')).toContain('readings[2]');
    }

    // readings 合法但 queries 非法：本模块虽不用 queries，契约仍整体验证
    await store.loadFileIntoSlot(
      'A',
      'q.json',
      textOf(fileText([1, 2, 3], [{ start: 0, end: 3, k: 4 }])),
    );
    scheduler.runAll();
    state = store.getState();
    expect(state.slots.A.status).toBe('error');
    if (state.slots.A.status === 'error') {
      expect(state.slots.A.errors.join('\n')).toContain('queries[0]');
    }
  });

  it('文件读取失败：只标记该槽', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    await store.loadFileIntoSlot('C', 'ok.json', textOf(fileText([5])));
    await store.loadFileIntoSlot('A', 'io.json', () => Promise.reject(new Error('磁盘错误')));
    scheduler.runAll();
    const state = store.getState();
    expect(state.slots.A.status).toBe('error');
    if (state.slots.A.status === 'error') {
      expect(state.slots.A.errors.join('\n')).toContain('文件读取失败');
      expect(state.slots.A.errors.join('\n')).toContain('磁盘错误');
    }
    expect(state.slots.C.status).toBe('ready');
  });

  it('字节数闸门：超过 MAX_FILE_BYTES 的文件读取前拒绝，不调用 readText', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    const readText = vi.fn(() => Promise.resolve('{}'));

    await store.loadFileIntoSlot('A', 'oversize.json', readText, {
      byteSize: MAX_FILE_BYTES + 1,
    });
    expect(readText).not.toHaveBeenCalled();

    const state = store.getState();
    expect(state.slots.A.status).toBe('error');
    if (state.slots.A.status === 'error') {
      expect(state.slots.A.errors.length).toBe(1);
      expect(state.slots.A.errors[0]).toContain('文件过大');
      expect(state.slots.A.errors[0]).toContain(formatByteSize(MAX_FILE_BYTES + 1));
    }
    expect(scheduler.pending).toBe(0);
  });
});

describe('ChainStore：快速换文件，迟到的解析与匹配结果不得混入', () => {
  it('同一槽位的晚到读取回调不得覆盖更新的选择', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    const slow = deferred<string>();

    // 第一次选择：读取挂起
    const first = store.loadFileIntoSlot('A', 'slow.json', () => slow.promise);
    expect(store.getState().slots.A.status).toBe('loading');

    // 质检员改主意，第二次选择同名槽位并立即成功
    await store.loadFileIntoSlot('A', 'fast.json', textOf(fileText([7, 7, 7])));
    scheduler.runAll();
    expect(store.getState().slots.A.status).toBe('ready');

    // 迟到的第一次读取此时才兑现：其解析续体入队后在下一调度点自行终止
    slow.resolve(fileText([1, 1, 1]));
    await first;
    expect(store.getState().slots.A.status).toBe('ready');
    scheduler.runAll();
    const state = store.getState();
    expect(state.slots.A.status).toBe('ready');
    if (state.slots.A.status === 'ready') {
      expect(state.slots.A.fileName).toBe('fast.json');
      expect(state.slots.A.readings).toEqual([7, 7, 7]);
    }
  });

  it('读取中被替换：旧文本不解析、不校验，槽位留在新文件状态', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    const huge = deferred<string>();
    const parseHuge = vi.fn((t: string) => JSON.parse(t));

    // 误选大文件，读取挂起
    const big = store.loadFileIntoSlot('A', 'huge.json', () => huge.promise, {
      parseText: parseHuge,
    });
    expect(store.getState().slots.A.status).toBe('loading');

    // 立即改选正确文件并先就绪
    await store.loadFileIntoSlot('A', 'correct.json', textOf(fileText([1, 2, 3])));
    scheduler.runAll();
    expect(store.getState().slots.A.status).toBe('ready');

    // 大文件读取此刻才兑现：旧续体仅入队，不立即执行
    huge.resolve(fileText(new Array(1_000_000).fill(-1)));
    await big;
    expect(scheduler.pending).toBe(1);
    expect(parseHuge).not.toHaveBeenCalled();

    // 泵出：旧续体在入口发现版本已变，自行终止——parse/validate 完全不发生
    scheduler.runAll();
    expect(parseHuge).not.toHaveBeenCalled();
    const state = store.getState();
    expect(state.slots.A.status).toBe('ready');
    if (state.slots.A.status === 'ready') {
      expect(state.slots.A.fileName).toBe('correct.json');
      expect(state.slots.A.readings).toEqual([1, 2, 3]);
    }
    expect(scheduler.pending).toBe(0);
  });

  it('读取中被取消：旧续体自行终止，槽位保持空槽', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);
    const slow = deferred<string>();
    const parseSpy = vi.fn((t: string) => JSON.parse(t));

    const pending = store.loadFileIntoSlot('B', 'slow.json', () => slow.promise, {
      parseText: parseSpy,
    });
    expect(store.getState().slots.B.status).toBe('loading');

    // 读取期间取消该槽
    store.clearSlot('B');
    expect(store.getState().slots.B.status).toBe('empty');

    // 迟到的读取兑现：续体入队后在下一调度点自行终止，不 parse、不就绪
    slow.resolve(fileText([1, 2, 3]));
    await pending;
    scheduler.runAll();
    expect(parseSpy).not.toHaveBeenCalled();
    expect(store.getState().slots.B.status).toBe('empty');
    expect(scheduler.pending).toBe(0);
  });

  it('被替换槽位的旧回调不得改变其余两槽与最近合法结论', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler);

    // 先建立一个合法拼接结论
    await store.loadFileIntoSlot('A', 'a.json', textOf(fileText([9, 1, 2])));
    await store.loadFileIntoSlot('B', 'b.json', textOf(fileText([2, 3])));
    await store.loadFileIntoSlot('C', 'c.json', textOf(fileText([3, 8])));
    scheduler.runAll();
    expect(store.getState().phase).toBe('chained');

    // 误选非法文件（读取挂起），结论立即撤销
    const stale = deferred<string>();
    const staleTask = store.loadFileIntoSlot('A', 'bad.json', () => stale.promise);
    expect(store.getState().result).toBeNull();
    expect(store.getState().slots.B.status).toBe('ready');
    expect(store.getState().slots.C.status).toBe('ready');

    // 改选正确的 A 并重新成立拼接链
    await store.loadFileIntoSlot('A', 'a2.json', textOf(fileText([0, 9, 1, 2])));
    scheduler.runAll();
    const mid = store.getState();
    expect(mid.phase).toBe('chained');
    expect((mid.result as ChainSolution).fileNames).toEqual(['a2.json', 'b.json', 'c.json']);

    // 非法旧文件兑现：续体终止，其余两槽与最近结论原样保留
    stale.resolve(fileText([1, 999999]));
    await staleTask;
    scheduler.runAll();

    const done = store.getState();
    expect(done.slots.A.status).toBe('ready');
    if (done.slots.A.status === 'ready') {
      expect(done.slots.A.fileName).toBe('a2.json');
    }
    expect(done.result).not.toBeNull();
    expect((done.result as ChainSolution).fileNames).toEqual(['a2.json', 'b.json', 'c.json']);
    expect(scheduler.pending).toBe(0);
  });

  it('三槽快速轮换文件：只有最后一组文件能留下结论', async () => {
    const scheduler = new ManualScheduler();
    const store = new ChainStore(scheduler, 1 << 20);
    for (const key of CHAIN_SLOT_KEYS) {
      await store.loadFileIntoSlot(key, `${key}1.json`, textOf(fileText([1, 1, 1])));
    }
    for (const key of CHAIN_SLOT_KEYS) {
      await store.loadFileIntoSlot(
        key,
        `${key}2.json`,
        textOf(fileText(key === 'A' ? [9, 1, 2] : key === 'B' ? [2, 3] : [3, 8])),
      );
    }
    scheduler.runAll();
    const state = store.getState();
    const r = state.result as ChainSolution;
    expect(r.kind).toBe('solution');
    expect(r.fileNames).toEqual(['A2.json', 'B2.json', 'C2.json']);
    expect(r.mergedCount).toBe(5);
  });
});
