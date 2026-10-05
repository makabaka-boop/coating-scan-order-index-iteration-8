import { describe, expect, it } from 'vitest';
import { computeSeamOverlap } from './seamCore';
import { ManualScheduler, SeamStore } from './seamStore';

/** 构造合法文件 JSON 文本（契约要求 readings 与 queries 同时合法） */
function fileText(readings: number[], queries: unknown[] = []): string {
  return JSON.stringify({ readings, queries });
}

/** 可手动兑现/拒绝的 Promise，用于精确控制文件读取回调的到达时机 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SeamStore：双槽位状态机', () => {
  it('空闲 → 单侧已载入 → 双侧匹配中 → 接缝成立，结果字段完整', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    expect(store.getState().phase).toBe('idle');
    expect(store.getState().result).toBeNull();

    const left = [4, 1, 2, 3, 1, 2, 3];
    const right = [1, 2, 3, 9, 9, 9, 9, 9, 9, 9];
    store.readySlot('left', 'front.json', left);
    expect(store.getState().phase).toBe('one-sided');
    expect(store.getState().result).toBeNull();

    store.readySlot('right', 'back.json', right);
    expect(store.getState().phase).toBe('matching');
    expect(scheduler.pending).toBeGreaterThan(0);

    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('seam');
    expect(state.result).not.toBeNull();
    const r = state.result!;
    expect(r.leftFileName).toBe('front.json');
    expect(r.rightFileName).toBe('back.json');
    expect(r.overlap).toBe(computeSeamOverlap(left, right));
    expect(r.overlap).toBe(3);
    expect(r.mergedCount).toBe(left.length + right.length - 3);
    expect(r.leftCount).toBe(left.length);
    expect(r.rightCount).toBe(right.length);
    // 上下文：前段末尾 / 后段开头各至多 8 条（left 仅 7 条，全部展示）
    expect(r.leftTail).toEqual(left);
    expect(r.rightHead).toEqual([1, 2, 3, 9, 9, 9, 9, 9]);
    expect(r.leftTail.length).toBeLessThanOrEqual(8);
    expect(r.rightHead.length).toBeLessThanOrEqual(8);
    expect(state.taskSeq).toBe(1);
  });

  it('零重叠进入无重叠终态，去重拼接长度为两侧之和', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    store.readySlot('left', 'a.json', [1, 2, 3]);
    store.readySlot('right', 'b.json', [7, 8, 9]);
    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('no-overlap');
    expect(state.result!.overlap).toBe(0);
    expect(state.result!.mergedCount).toBe(6);
  });

  it('替换任一侧立即撤销旧结论并重算，新结果只反映新配对', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    store.readySlot('left', 'L1.json', [1, 2, 3]);
    store.readySlot('right', 'R1.json', [2, 3, 4]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('seam');
    expect(store.getState().result!.overlap).toBe(2);

    // 替换前段：结论同步撤销，立刻回到匹配中
    store.readySlot('left', 'L2.json', [8, 8, 8]);
    const mid = store.getState();
    expect(mid.result).toBeNull();
    expect(mid.phase).toBe('matching');

    scheduler.runAll();
    const done = store.getState();
    expect(done.phase).toBe('no-overlap');
    expect(done.result!.leftFileName).toBe('L2.json');
    expect(done.result!.rightFileName).toBe('R1.json');
    expect(done.result!.overlap).toBe(0);
  });

  it('单侧失败只标记该槽且保留另一侧，结论同步撤销', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    store.readySlot('left', 'L.json', [1, 2, 3]);
    store.readySlot('right', 'R.json', [2, 3, 4]);
    scheduler.runAll();
    expect(store.getState().phase).toBe('seam');

    store.failSlot('left', 'bad.json', ['readings[0]：必须是整数']);
    const state = store.getState();
    expect(state.result).toBeNull();
    expect(state.phase).toBe('one-sided');
    expect(state.left.status).toBe('error');
    expect(state.right.status).toBe('ready');
    if (state.right.status === 'ready') {
      expect(state.right.fileName).toBe('R.json');
      expect(state.right.readings).toEqual([2, 3, 4]);
    }

    // 失败的槽位重新就绪后，与保留的另一侧重新配对
    store.readySlot('left', 'L2.json', [9, 2, 3]);
    scheduler.runAll();
    const again = store.getState();
    expect(again.phase).toBe('seam');
    expect(again.result!.leftFileName).toBe('L2.json');
    expect(again.result!.overlap).toBe(2);
  });
});

describe('SeamStore：可控调度器交错，替换或失败不回写旧结果', () => {
  it('匹配推进到一半时替换前段：旧任务在下一调度点终止，结果只属于新配对', () => {
    const scheduler = new ManualScheduler();
    // 分片预算 2：长度 9 + 9 的匹配需要多个分片，制造交错窗口
    const store = new SeamStore(scheduler, 2);
    const left1 = [5, 5, 5, 1, 2, 3, 4, 5, 6];
    const right1 = [3, 4, 5, 6, 7, 7, 7, 7, 7];
    const left2 = [9, 9, 9, 9, 9, 9, 9, 9, 8];

    store.readySlot('left', 'L1.json', left1);
    store.readySlot('right', 'R1.json', right1);
    expect(store.getState().taskSeq).toBe(1);

    // 旧任务只推进一个分片，尚未完成
    expect(scheduler.runNext()).toBe(true);
    expect(store.getState().result).toBeNull();

    // 替换前段：旧任务作废，新任务排入队列（旧任务的后续分片仍在队列中）
    store.readySlot('left', 'L2.json', left2);
    expect(store.getState().taskSeq).toBe(2);
    expect(store.getState().result).toBeNull();

    scheduler.runAll();
    const state = store.getState();
    // 最终结果必须反映 L2 × R1，而不是 L1 × R1
    expect(state.result!.leftFileName).toBe('L2.json');
    expect(state.result!.rightFileName).toBe('R1.json');
    expect(state.result!.overlap).toBe(computeSeamOverlap(left2, right1));
    expect(state.result!.overlap).toBe(0);
    expect(state.phase).toBe('no-overlap');
    // 旧任务的结论若回写，overlap 会是 4（L1 × R1），这里显式排除
    expect(state.result!.overlap).not.toBe(computeSeamOverlap(left1, right1));
  });

  it('旧任务的完成分片晚到：队列中先于新任务执行，也不得覆盖当前状态', () => {
    const scheduler = new ManualScheduler();
    // 预算足够大：每个任务一个分片即可完成
    const store = new SeamStore(scheduler, 1000);
    store.readySlot('left', 'L1.json', [1, 2, 3, 4]);
    store.readySlot('right', 'R1.json', [2, 3, 4, 5]);
    // 旧任务的唯一分片已在队列中，但尚未执行
    expect(scheduler.pending).toBe(1);

    // 在旧分片执行前替换前段：新任务排在其后
    store.readySlot('left', 'L2.json', [7, 7, 7, 7]);
    expect(scheduler.pending).toBe(2);

    scheduler.runAll();
    const state = store.getState();
    // 若缺少身份核验，旧分片会先提交 L1×R1 的结论并阻塞新任务提交
    expect(state.result!.leftFileName).toBe('L2.json');
    expect(state.result!.overlap).toBe(computeSeamOverlap([7, 7, 7, 7], [2, 3, 4, 5]));
    expect(state.result!.overlap).toBe(0);
    expect(state.taskSeq).toBe(2);
  });

  it('匹配进行中单侧失败：结论撤销、另一侧保留，旧任务晚到分片不得回写', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 2);
    store.readySlot('left', 'L.json', [1, 2, 3, 4, 5, 6]);
    store.readySlot('right', 'R.json', [3, 4, 5, 6, 0, 0]);

    // 推进一个分片后让右侧失败
    expect(scheduler.runNext()).toBe(true);
    store.failSlot('right', 'R-bad.json', ['queries[0]：k 越界']);

    const mid = store.getState();
    expect(mid.phase).toBe('one-sided');
    expect(mid.result).toBeNull();
    expect(mid.left.status).toBe('ready');
    expect(mid.right.status).toBe('error');

    // 泵空队列：旧任务的剩余分片不得提交任何结论
    scheduler.runAll();
    const done = store.getState();
    expect(done.result).toBeNull();
    expect(done.phase).toBe('one-sided');
    expect(done.left.status).toBe('ready');
  });

  it('连续快速替换：只有最后一组配对能留下结论', () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler, 1000);
    store.readySlot('left', 'L1.json', [1, 1, 1]);
    store.readySlot('right', 'R1.json', [1, 1, 1]);
    store.readySlot('left', 'L2.json', [2, 2, 2]);
    store.readySlot('right', 'R2.json', [3, 3, 3]);
    store.readySlot('left', 'L3.json', [4, 3, 3]);
    // 队列中积压了多个被作废任务的分片
    expect(scheduler.pending).toBeGreaterThan(1);

    scheduler.runAll();
    const state = store.getState();
    expect(state.result!.leftFileName).toBe('L3.json');
    expect(state.result!.rightFileName).toBe('R2.json');
    expect(state.result!.overlap).toBe(2);
    expect(state.phase).toBe('seam');
  });
});

describe('SeamStore：本地 JSON 入口（整文件契约验证，只取 readings）', () => {
  it('合法文件进入槽位并触发匹配；queries 为空也合法', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    await store.loadFileIntoSlot('left', 'f.json', () => Promise.resolve(fileText([1, 2, 3])));
    // 解析续体经调度器排队：泵出后槽位才就绪
    scheduler.runAll();
    expect(store.getState().left.status).toBe('ready');
    await store.loadFileIntoSlot('right', 'b.json', () => Promise.resolve(fileText([2, 3, 4])));
    scheduler.runAll();
    const state = store.getState();
    expect(state.phase).toBe('seam');
    expect(state.result!.overlap).toBe(2);
  });

  it('JSON 语法错误：只标记该槽，保留另一侧', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    await store.loadFileIntoSlot('left', 'ok.json', () => Promise.resolve(fileText([1, 2, 3])));
    await store.loadFileIntoSlot('right', 'bad.json', () => Promise.resolve('{ not json'));
    scheduler.runAll();
    const state = store.getState();
    expect(state.left.status).toBe('ready');
    expect(state.right.status).toBe('error');
    if (state.right.status === 'error') {
      expect(state.right.errors.join('\n')).toContain('JSON 语法错误');
    }
    expect(state.phase).toBe('one-sided');
  });

  it('契约错误按下标反馈：readings 越界与 queries 非法都整体拒绝', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    await store.loadFileIntoSlot('left', 'r.json', () =>
      Promise.resolve(fileText([1, 2, 65536])),
    );
    scheduler.runAll();
    let state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors.join('\n')).toContain('readings[2]');
    }

    // readings 合法但 queries 非法：本模块虽不用 queries，契约仍整体验证
    await store.loadFileIntoSlot('left', 'q.json', () =>
      Promise.resolve(fileText([1, 2, 3], [{ start: 0, end: 3, k: 4 }])),
    );
    scheduler.runAll();
    state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors.join('\n')).toContain('queries[0]');
    }
  });

  it('文件读取失败：只标记该槽', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    await store.loadFileIntoSlot('right', 'ok.json', () => Promise.resolve(fileText([5])));
    await store.loadFileIntoSlot('left', 'io.json', () =>
      Promise.reject(new Error('磁盘错误')),
    );
    scheduler.runAll();
    const state = store.getState();
    expect(state.left.status).toBe('error');
    if (state.left.status === 'error') {
      expect(state.left.errors.join('\n')).toContain('文件读取失败');
      expect(state.left.errors.join('\n')).toContain('磁盘错误');
    }
    expect(state.right.status).toBe('ready');
  });

  it('同一槽位的晚到读取回调不得覆盖更新的选择', async () => {
    const scheduler = new ManualScheduler();
    const store = new SeamStore(scheduler);
    const slow = deferred<string>();

    // 第一次选择：读取挂起
    const first = store.loadFileIntoSlot('left', 'slow.json', () => slow.promise);
    expect(store.getState().left.status).toBe('loading');

    // 用户改主意，第二次选择同名槽位并立即成功
    await store.loadFileIntoSlot('left', 'fast.json', () =>
      Promise.resolve(fileText([7, 7, 7])),
    );
    scheduler.runAll();
    expect(store.getState().left.status).toBe('ready');

    // 迟到的第一次读取此时才兑现：其解析续体入队后在下一调度点自行终止
    slow.resolve(fileText([1, 1, 1]));
    await first;
    // 续体已在队列中但尚未执行：当前状态不受影响
    expect(store.getState().left.status).toBe('ready');
    scheduler.runAll();
    const state = store.getState();
    expect(state.left.status).toBe('ready');
    if (state.left.status === 'ready') {
      expect(state.left.fileName).toBe('fast.json');
      expect(state.left.readings).toEqual([7, 7, 7]);
    }
  });
});
