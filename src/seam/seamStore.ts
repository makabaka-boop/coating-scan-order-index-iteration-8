import { validateInput } from '../validation';
import { MAX_FILE_BYTES, QUERIES_MAX, READINGS_MAX, formatByteSize } from '../types';
import {
  CONTEXT_MAX,
  createSeamMatcher,
  headContext,
  tailContext,
} from './seamCore';

/**
 * 扫描片段接缝 · 双槽位状态存储（框架无关，React 通过 subscribe 观察）。
 *
 * 关键不变量：
 * - 每个槽位独立经历 空 → 读取中 → 就绪 / 错误；单侧失败只标记该槽，另一侧原样保留；
 * - 任何槽位变动都立即撤销旧结论（result 置空）并作废在途任务（匹配与读取/解析都包括）；
 * - 匹配任务以「双侧版本身份」绑定：任务令牌记录启动时的 leftVersion / rightVersion
 *   与唯一 taskId，只有三者仍与当前一致才允许推进或提交；
 * - 读取完成后的 JSON 解析与契约校验同样经由调度器排队，并在执行入口核验槽位版本：
 *   槽位被替换后，旧文件的解析续体在下一调度点自行终止——不 parse、不校验、
 *   也不入队后续工作，新文件不再被已作废的大文件拖住；
 * - 超过 MAX_FILE_BYTES 的文件在读取前直接拒绝（有界单条诊断），不把超限文本读入内存；
 *   校验产生的逐条错误也由 validateInput 统一封顶，不随输入长度线性增长；
 * - 旧任务被作废后不会立刻被清除，而是在下一个调度点（分片/续体入口）自行终止；
 *   其晚到的完成回调在提交前再次核验身份，绝不能覆盖当前状态；
 * - 分片经由 Scheduler 让出，界面在匹配期间仍可继续选择文件。
 */

export type SlotSide = 'left' | 'right';

export type SlotState =
  | { status: 'empty' }
  | { status: 'loading'; fileName: string }
  | { status: 'error'; fileName: string; errors: string[] }
  | { status: 'ready'; fileName: string; readings: number[] };

/** 双槽位整体阶段：空闲 → 单侧已载入 → 双侧匹配中 → 接缝成立 / 无重叠 */
export type SeamPhase = 'idle' | 'one-sided' | 'matching' | 'seam' | 'no-overlap';

export interface SeamResult {
  leftFileName: string;
  rightFileName: string;
  leftCount: number;
  rightCount: number;
  /** left 后缀与 right 前缀的最大严格相等长度 */
  overlap: number;
  /** 去重拼接长度 = leftCount + rightCount − overlap */
  mergedCount: number;
  /** 前段末尾至多 CONTEXT_MAX 条读数 */
  leftTail: number[];
  /** 后段开头至多 CONTEXT_MAX 条读数 */
  rightHead: number[];
  timingMs: number;
}

export interface SeamStoreState {
  left: SlotState;
  right: SlotState;
  phase: SeamPhase;
  result: SeamResult | null;
  /** 各槽位版本号：每次槽位变动单调递增，匹配任务以此绑定身份 */
  leftVersion: number;
  rightVersion: number;
  /** 已启动的匹配任务总数（含被作废的），用于观察替换是否作废旧任务 */
  taskSeq: number;
}

/** 调度器抽象：浏览器用 setTimeout 让出主线程，测试用手动队列精确交错 */
export interface Scheduler {
  schedule(task: () => void): void;
}

export function createTimeoutScheduler(): Scheduler {
  return {
    schedule(task) {
      setTimeout(task, 0);
    },
  };
}

/** 手动调度器：任务进入队列，由调用方逐个或全部泵出，用于确定性交错测试 */
export class ManualScheduler implements Scheduler {
  private readonly queue: Array<() => void> = [];

  schedule(task: () => void): void {
    this.queue.push(task);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** 执行队首任务；队列为空时返回 false */
  runNext(): boolean {
    const task = this.queue.shift();
    if (!task) return false;
    task();
    return true;
  }

  /** 泵空队列（任务在执行中新排入的也会继续执行） */
  runAll(): void {
    while (this.runNext()) {
      // 直至队列清空
    }
  }
}

/** 匹配任务的双侧版本身份 */
interface SeamTaskToken {
  readonly taskId: number;
  readonly leftVersion: number;
  readonly rightVersion: number;
}

/** 每个分片处理的元素个数：20 万 + 20 万规模约 25 个分片，界面保持可交互 */
export const DEFAULT_SLICE_BUDGET = 16_384;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SeamStore {
  private leftSlot: SlotState = { status: 'empty' };
  private rightSlot: SlotState = { status: 'empty' };
  private result: SeamResult | null = null;
  private leftVersion = 0;
  private rightVersion = 0;
  private taskSeq = 0;
  private activeToken: SeamTaskToken | null = null;
  private state: SeamStoreState;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly scheduler: Scheduler,
    private readonly sliceBudget: number = DEFAULT_SLICE_BUDGET,
  ) {
    this.state = this.snapshot();
  }

  getState(): SeamStoreState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 槽位进入读取中：立即撤销旧结论、作废在途任务。
   * 返回该槽位的新版本号，供异步读取完成时核验身份（晚到回调不得覆盖）。
   */
  beginSlot(side: SlotSide, fileName: string): number {
    const ticket = this.bumpVersion(side);
    this.setSlot(side, { status: 'loading', fileName });
    this.afterSlotChange();
    return ticket;
  }

  /** 槽位读取/校验失败：只标记该槽，保留另一侧；ticket 过期则忽略 */
  failSlot(side: SlotSide, fileName: string, errors: string[], ticket?: number): void {
    if (ticket !== undefined && ticket !== this.versionOf(side)) return;
    this.bumpVersion(side);
    this.setSlot(side, { status: 'error', fileName, errors: errors.slice() });
    this.afterSlotChange();
  }

  /** 槽位就绪：撤销旧结论；若双侧均已就绪则启动新的匹配任务 */
  readySlot(side: SlotSide, fileName: string, readings: number[], ticket?: number): void {
    if (ticket !== undefined && ticket !== this.versionOf(side)) return;
    this.bumpVersion(side);
    // 拷贝一份，冻结任务输入，避免调用方后续修改造成别名污染
    this.setSlot(side, { status: 'ready', fileName, readings: readings.slice() });
    this.afterSlotChange();
  }

  /**
   * 本地 JSON 入口：
   * 1. beginSlot 立即作废该槽一切在途任务并进入读取中；
   * 2. 已知字节数超 MAX_FILE_BYTES 时读取前直接拒绝，不读入超限文本；
   * 3. 读取文本；读取失败只标记该槽；
   * 4. 把 JSON.parse + 契约整体验证排入调度器：
   *    续体执行时若槽位版本已变化（读取期间被新文件替换），旧续体自行终止，
   *    不再占用主线程，也绝不 fail/ready 当前槽位或改变另一侧；
   *    晚到的读取回调同理——续体只在执行入口核验一次身份即可（排队期间不会变化）。
   * 本模块只取用 readings，不调用查询分析；queries 非法同样导致整个文件被拒。
   *
   * 返回的 Promise 在「解析续体入队后」兑现，随后必须由调度器泵出才会改状态，
   * 与匹配分片使用同一个调度点机制（浏览器 setTimeout / 测试手动队列）。
   */
  async loadFileIntoSlot(
    side: SlotSide,
    fileName: string,
    readText: () => Promise<string>,
    options?: { byteSize?: number; parseText?: (text: string) => unknown },
  ): Promise<void> {
    const ticket = this.beginSlot(side, fileName);

    // 读取前规模闸门：超限文件不进入文件读取，诊断有界且可定位
    if (options?.byteSize !== undefined && options.byteSize > MAX_FILE_BYTES) {
      this.failSlot(
        side,
        fileName,
        [
          `文件过大：${formatByteSize(options.byteSize)} 超出 ${formatByteSize(MAX_FILE_BYTES)} 上限，读取前拒绝（契约：${READINGS_MAX} 条读数 / ${QUERIES_MAX} 条查询）`,
        ],
        ticket,
      );
      return;
    }

    let text: string;
    try {
      text = await readText();
    } catch (e) {
      this.failSlot(side, fileName, [`文件读取失败：${errorMessage(e)}`], ticket);
      return;
    }

    // 解析/校验续体经调度器排队：槽位在此期间被替换时，旧续体在执行入口
    // 发现 ticket 过期便自行终止，不再 parse/校验，也不入队任何后续工作。
    const parseText = options?.parseText ?? JSON.parse;
    this.scheduler.schedule(() => {
      if (ticket !== this.versionOf(side)) return;

      let parsed: unknown;
      try {
        parsed = parseText(text);
      } catch (e) {
        this.failSlot(side, fileName, [`JSON 语法错误，整个文件被拒绝：${errorMessage(e)}`], ticket);
        return;
      }

      const verdict = validateInput(parsed);
      if (!verdict.ok) {
        this.failSlot(side, fileName, verdict.errors, ticket);
        return;
      }
      this.readySlot(side, fileName, verdict.input.readings, ticket);
    });
  }

  private versionOf(side: SlotSide): number {
    return side === 'left' ? this.leftVersion : this.rightVersion;
  }

  private bumpVersion(side: SlotSide): number {
    if (side === 'left') {
      this.leftVersion++;
      return this.leftVersion;
    }
    this.rightVersion++;
    return this.rightVersion;
  }

  private setSlot(side: SlotSide, slot: SlotState): void {
    if (side === 'left') {
      this.leftSlot = slot;
    } else {
      this.rightSlot = slot;
    }
  }

  /** 任何槽位变动的公共后果：撤销旧结论、作废旧任务、必要时启动新匹配 */
  private afterSlotChange(): void {
    this.activeToken = null; // 旧任务在下一调度点发现身份失效后自行终止
    this.result = null;
    if (this.leftSlot.status === 'ready' && this.rightSlot.status === 'ready') {
      this.startMatch(this.leftSlot, this.rightSlot);
    }
    this.publish();
  }

  private startMatch(
    left: { fileName: string; readings: number[] },
    right: { fileName: string; readings: number[] },
  ): void {
    const token: SeamTaskToken = {
      taskId: ++this.taskSeq,
      leftVersion: this.leftVersion,
      rightVersion: this.rightVersion,
    };
    this.activeToken = token;

    const matcher = createSeamMatcher(left.readings, right.readings);
    const startedAt = now();

    const runSlice = (): void => {
      // 调度点：身份已失效的旧任务在此终止，不推进、不提交
      if (!this.isCurrent(token)) return;

      if (!matcher.step(this.sliceBudget)) {
        this.scheduler.schedule(runSlice);
        return;
      }

      // 提交前再次核验：晚到回调绝不能覆盖当前状态
      if (!this.isCurrent(token)) return;

      const overlap = matcher.overlap();
      this.activeToken = null;
      this.result = {
        leftFileName: left.fileName,
        rightFileName: right.fileName,
        leftCount: left.readings.length,
        rightCount: right.readings.length,
        overlap,
        mergedCount: left.readings.length + right.readings.length - overlap,
        leftTail: tailContext(left.readings, CONTEXT_MAX),
        rightHead: headContext(right.readings, CONTEXT_MAX),
        timingMs: now() - startedAt,
      };
      this.publish();
    };

    this.scheduler.schedule(runSlice);
  }

  /** 任务身份核验：令牌仍是在途任务，且双侧版本与启动时一致 */
  private isCurrent(token: SeamTaskToken): boolean {
    return (
      this.activeToken !== null &&
      this.activeToken.taskId === token.taskId &&
      token.leftVersion === this.leftVersion &&
      token.rightVersion === this.rightVersion
    );
  }

  private derivePhase(): SeamPhase {
    if (this.result) return this.result.overlap > 0 ? 'seam' : 'no-overlap';
    if (this.activeToken) return 'matching';
    const leftReady = this.leftSlot.status === 'ready';
    const rightReady = this.rightSlot.status === 'ready';
    if (leftReady && rightReady) return 'matching'; // 任务已调度、尚未跑首个分片
    if (leftReady || rightReady) return 'one-sided';
    return 'idle';
  }

  private snapshot(): SeamStoreState {
    return {
      left: this.leftSlot,
      right: this.rightSlot,
      phase: this.derivePhase(),
      result: this.result,
      leftVersion: this.leftVersion,
      rightVersion: this.rightVersion,
      taskSeq: this.taskSeq,
    };
  }

  private publish(): void {
    this.state = this.snapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }
}
