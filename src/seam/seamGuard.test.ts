import { describe, expect, it, vi } from 'vitest';
import { computeSeamOverlap } from './seamCore';
import { ManualScheduler, SeamStore } from './seamStore';
import { MAX_FILE_BYTES, READINGS_MAX, formatByteSize } from '../types';

/**
 * 前置数据保护 · 验收二：槽位被替换后，旧的读取/解析/校验任务
 * 不得继续延迟当前文件，也不得改变另一槽位与最近合法结果。
 *
 * 前置流水线（读取续体的 parse + validate）与匹配分片共用同一调度点与
 * 身份保护：旧续体在下一调度点发现槽位版本已变即自行终止，
 * 不进入解析、不入队后续工作；读取前另有字节数闸门。
 */

function fileText(readings: number[], queries: unknown[] = []): string {
  return JSON.stringify({ readings, queries });
}

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

describe('读取中被替换：旧解析任务在下一调度点终止', () => {
  it('大文件读取兑现后被替换：旧文本不解析、不校验，槽位留在新文件状态', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const huge = deferred<string>();
    const parseHuge = vi.fn((t: string) => JSON.parse(t));

    // 误选远超约定规模的大文件，读取挂起
    const big = store.loadFileIntoSlot(
      'left',
      'huge.json',
      () => huge.promise,
      { parseText: parseHuge },
    );
    expect(store.getState().left.status).toBe('loading');

    // 质检员立即改选正确文件并先就绪
    await store.loadFileIntoSlot('left', 'correct.json', textOf(fileText([1, 2, 3])));
    scheduler.runAll();
    const readyState = store.getState();
    expect(readyState.left.status).toBe('ready');
    if (readyState.left.status === 'ready') {
      expect(readyState.left.fileName).toBe('correct.json');
    }

    // 大文件读取此刻才兑现：旧续体仅入队，不立即执行
    huge.resolve(fileText(new Array(1_000_000).fill(-1)));
    await big;
    expect(scheduler.pending).toBe(1);
    expect(parseHuge).not.toHaveBeenCalled();

    // 泵出：旧续体在入口发现版本已变，自行终止——parse/validate 完全不发生
    scheduler.runAll();
    expect(parseHuge).not.toHaveBeenCalled();

    const state = store.getState();
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      expect(state.left.fileName).toBe('correct.json');
      expect(state.left.readings).toEqual([1, 2, 3]);
    }
    // 队列必须被泵空：旧任务没有残留续体
    expect(scheduler.pending).toBe(0);
  });

  it('旧续体终止后不留下任何调度队列垃圾（多次替换也成立）', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);

    const d1 = deferred<string>();
    const d2 = deferred<string>();
    const p1 = store.loadFileIntoSlot('left', 'a.json', () => d1.promise);
    const p2 = store.loadFileIntoSlot('left', 'b.json', () => d2.promise);
    await store.loadFileIntoSlot('left', 'c.json', textOf(fileText([9])));
    scheduler.runAll();
    const cState = store.getState();
    expect(cState.left.status).toBe('ready');
    if (cState.left.status === 'ready') {
      expect(cState.left.fileName).toBe('c.json');
    }

    d1.resolve(fileText([1]));
    d2.resolve(fileText([2]));
    await Promise.all([p1, p2]);
    expect(scheduler.pending).toBe(2);
    scheduler.runAll();
    expect(scheduler.pending).toBe(0);

    const state = store.getState();
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      expect(state.left.fileName).toBe('c.json');
      expect(state.left.readings).toEqual([9]);
    }
  });

  it('被替换槽位的旧失败/旧就绪回调都不得改变另一槽位与最近合法结论', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 1000);

    // 先建立一个合法接缝结论
    store.readySlot('right', 'R1.json', [2, 3, 4, 5]);
    await store.loadFileIntoSlot('left', 'L1.json', textOf(fileText([1, 2, 3, 4])));
    scheduler.runAll();
    expect(store.getState().phase).toBe('seam');
    expect(store.getState().result!.overlap).toBe(3);

    // 误选非法大文件（读取挂起），结论立即撤销
    const stale = deferred<string>();
    const staleTask = store.loadFileIntoSlot('left', 'bad.json', () => stale.promise);
    expect(store.getState().result).toBeNull();
    expect(store.getState().right.status).toBe('ready');

    // 改选正确的前段并重新成立接缝
    await store.loadFileIntoSlot('left', 'L2.json', textOf(fileText([8, 2, 3])));
    scheduler.runAll();
    const mid = store.getState();
    expect(mid.phase).toBe('seam');
    expect(mid.result!.leftFileName).toBe('L2.json');
    expect(mid.result!.rightFileName).toBe('R1.json');
    expect(mid.result!.overlap).toBe(computeSeamOverlap([8, 2, 3], [2, 3, 4, 5]));
    expect(mid.result!.overlap).toBe(2);

    // 非法旧文件兑现：续体终止，另一槽位与最近结论原样保留
    stale.resolve(fileText([1, 999999]));
    await staleTask;
    scheduler.runAll();

    const done = store.getState();
    expect(done.left.status).toBe('ready');
    expect(done.right.status).toBe('ready');
    if (done.left.status === 'ready') expect(done.left.fileName).toBe('L2.json');
    if (done.right.status === 'ready') {
      expect(done.right.fileName).toBe('R1.json');
      expect(done.right.readings).toEqual([2, 3, 4, 5]);
    }
    expect(done.result).not.toBeNull();
    expect(done.result!.leftFileName).toBe('L2.json');
    expect(done.result!.overlap).toBe(2);
    expect(scheduler.pending).toBe(0);
  });

  it('当前合法文件不再被旧大文件拖住：替换后无需泵出任何旧续体即可完成新解析', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const huge = deferred<string>();
    const neverParsed = vi.fn((t: string) => JSON.parse(t));

    const old = store.loadFileIntoSlot('left', 'huge.json', () => huge.promise, {
      parseText: neverParsed,
    });
    await store.loadFileIntoSlot('left', 'good.json', textOf(fileText([4, 5, 6])));

    // 只泵一次：新续体必须独立完成，不依赖旧续体让出
    expect(scheduler.runNext()).toBe(true);
    const state = store.getState();
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      expect(state.left.fileName).toBe('good.json');
    }

    huge.resolve(fileText([1]));
    await old;
    scheduler.runAll();
    expect(neverParsed).not.toHaveBeenCalled();
  });

  it('读取拒绝（Promise reject）的晚到回调同样被忽略', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const slow = deferred<string>();

    const first = store.loadFileIntoSlot('right', 'slow.json', () => slow.promise);
    await store.loadFileIntoSlot('right', 'fast.json', textOf(fileText([7])));
    scheduler.runAll();
    expect(store.getState().right.status).toBe('ready');

    slow.reject(new Error('磁盘错误'));
    await first;
    scheduler.runAll();
    const state = store.getState();
    expect(state.right.status).toBe('ready');
    if (state.right.status === 'ready') expect(state.right.fileName).toBe('fast.json');
  });

  it('字节数闸门：超过 MAX_FILE_BYTES 的文件读取前拒绝，不调用 readText，错误有界', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const readText = vi.fn(() => Promise.resolve('{}'));

    await store.loadFileIntoSlot(
      'left',
      'oversize.json',
      readText,
      { byteSize: MAX_FILE_BYTES + 1 },
    );
    expect(readText).not.toHaveBeenCalled();

    const state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors.length).toBe(1);
      expect(state.left.errors[0]).toContain('文件过大');
      expect(state.left.errors[0]).toContain(formatByteSize(MAX_FILE_BYTES + 1));
    }
    // 读取前拒绝是同步的：调度队列中不应残留该任务的续体
    expect(scheduler.pending).toBe(0);
  });

  it('恰好 MAX_FILE_BYTES 的文件正常进入读取与解析', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const readText = vi.fn(() => Promise.resolve(fileText([1, 2])));

    await store.loadFileIntoSlot('left', 'edge.json', readText, { byteSize: MAX_FILE_BYTES });
    expect(readText).toHaveBeenCalledTimes(1);
    scheduler.runAll();
    expect(store.getState().left.status).toBe('ready');
  });

  it('字节数闸门只作用于声明了 byteSize 的入口（无 size 信息时不影响正常流程）', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    await store.loadFileIntoSlot('left', 'unknown-size.json', textOf(fileText([1])));
    scheduler.runAll();
    expect(store.getState().left.status).toBe('ready');
  });

  it('满规模合法文本经调度续体解析成功（前置流水线与上限契约兼容）', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const readings = new Array(READINGS_MAX).fill(1);
    await store.loadFileIntoSlot('left', 'full.json', textOf(fileText(readings)));
    scheduler.runAll();
    const state = store.getState();
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      expect(state.left.readings.length).toBe(READINGS_MAX);
    }
  });
});
