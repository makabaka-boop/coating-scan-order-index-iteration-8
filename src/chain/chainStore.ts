import { validateInput } from '../validation';
import { MAX_FILE_BYTES, QUERIES_MAX, READINGS_MAX, formatByteSize } from '../types';
import { CONTEXT_MAX } from '../seam/seamCore';
import type { Scheduler } from '../seam/seamStore';
import {
  chainHeadPreview,
  chainTailPreview,
  createChainMatcher,
  type ChainPlan,
} from './chainCore';
import { reviewChainWindow, type ChainReviewResult, type ChainWindowQuery } from './chainReview';

/**
 * 三段拼接链 · 三槽位状态存储（框架无关，React 通过 subscribe 观察）。
 *
 * 与双槽接缝同一套不变量，扩展到三个独立槽位：
 * - 每个槽位独立经历 空 → 读取中 → 就绪 / 错误；单槽失败只标记该槽，其余两槽原样保留；
 * - 任何槽位变动（替换、失败、取消）都立即撤销旧结论并作废在途任务
 *   （链式匹配与读取/解析都包括）；
 * - 链式任务以「三槽版本身份」绑定：任务令牌记录启动时的三个槽位版本与唯一
 *   taskId，只有四者仍与当前一致才允许推进或提交；
 * - 读取完成后的 JSON 解析与契约校验同样经调度器排队，并在执行入口核验槽位版本：
 *   槽位被替换或取消后，旧文件的解析续体在下一调度点自行终止——不 parse、不校验、
 *   也不入队后续工作；迟到的解析与匹配结果绝不混入新文件；
 * - 超过 MAX_FILE_BYTES 的文件在读取前直接拒绝（有界单条诊断）；
 * - 文件按 readings/queries 契约整体验证（queries 非法同样拒收），
 *   但本模块只把 readings 交给拼接服务，不调用查询分析；
 * - 三槽均就绪后枚举六种有向顺序裁定拼接链，分片经 Scheduler 让出，
 *   匹配期间界面仍可继续选择或取消文件。
 */

export type ChainSlotKey = 'A' | 'B' | 'C';

/** 槽位名称顺序：并列最优方案按此字典序裁决（与 chainCore 的枚举顺序一致） */
export const CHAIN_SLOT_KEYS: readonly ChainSlotKey[] = ['A', 'B', 'C'];

export type ChainSlotState =
  | { status: 'empty' }
  | { status: 'loading'; fileName: string }
  | { status: 'error'; fileName: string; errors: string[] }
  | { status: 'ready'; fileName: string; readings: number[] };

/** 三槽位整体阶段：空闲 → 部分就绪 → 匹配中 → 拼接成立 / 无合法顺序 */
export type ChainPhase = 'idle' | 'partial' | 'matching' | 'chained' | 'no-chain';

/** 拼接成立：最终顺序、两道接缝长度与合成预览 */
export interface ChainSolution {
  kind: 'solution';
  /** 最终顺序（槽位名称，如 ['B','A','C']） */
  order: [ChainSlotKey, ChainSlotKey, ChainSlotKey];
  /** 与 order 一一对应的文件名 */
  fileNames: [string, string, string];
  /** 按槽位 A/B/C 排列的文件名，供来源证据定位 */
  slotFileNames: [string, string, string];
  /** 与 order 一一对应的读数条数 */
  counts: [number, number, number];
  /** 接缝一：首份后缀 ≡ 次份前缀的重叠长度 */
  overlap1: number;
  /** 接缝二：合成序列后缀 ≡ 末份前缀的重叠长度 */
  overlap2: number;
  /** 合成长度 = 三份条数之和 − overlap1 − overlap2 */
  mergedCount: number;
  /** 合成长度不超过原单文件查询索引上限时，允许做一次性窗口复核 */
  reviewEnabled: boolean;
  /** reviewEnabled 为 false 时给出只禁用复核、不废弃拼接的原因 */
  reviewDisabledReason?: string;
  /** 合成序列开头至多 CONTEXT_MAX 条读数 */
  head: number[];
  /** 合成序列末尾至多 CONTEXT_MAX 条读数 */
  tail: number[];
  timingMs: number;
}

/** 三份均有效但六种有向顺序均不满足接缝约束 */
export interface ChainNoSolution {
  kind: 'none';
  /** 槽位 A/B/C 各自的文件名（按槽位顺序，便于核对） */
  fileNames: [string, string, string];
  timingMs: number;
}

export type ChainResult = ChainSolution | ChainNoSolution;

export interface ChainStoreState {
  slots: Record<ChainSlotKey, ChainSlotState>;
  phase: ChainPhase;
  result: ChainResult | null;
  /** 当前拼接方案上最近一次窗口复核；槽位变动、无方案或方案切换时立即撤销 */
  review: ChainReviewResult | null;
  /** 各槽位版本号：每次槽位变动单调递增，链式任务以此绑定身份 */
  versions: Record<ChainSlotKey, number>;
  /** 已启动的链式任务总数（含被作废的），用于观察替换是否作废旧任务 */
  taskSeq: number;
}

/** 链式任务的三槽版本身份 */
interface ChainTaskToken {
  readonly taskId: number;
  readonly versionA: number;
  readonly versionB: number;
  readonly versionC: number;
}

/**
 * 每个分片处理的元素个数：六种顺序至多十二道接缝加三次物化，
 * 满规模（3 × 20 万）约 130 个分片，界面保持可交互
 */
export const DEFAULT_CHAIN_SLICE_BUDGET = 65_536;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class ChainStore {
  private slots: Record<ChainSlotKey, ChainSlotState> = {
    A: { status: 'empty' },
    B: { status: 'empty' },
    C: { status: 'empty' },
  };
  private result: ChainResult | null = null;
  private review: ChainReviewResult | null = null;
  private versions: Record<ChainSlotKey, number> = { A: 0, B: 0, C: 0 };
  private taskSeq = 0;
  private activeToken: ChainTaskToken | null = null;
  private state: ChainStoreState;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly scheduler: Scheduler,
    private readonly sliceBudget: number = DEFAULT_CHAIN_SLICE_BUDGET,
  ) {
    this.state = this.snapshot();
  }

  getState(): ChainStoreState {
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
  beginSlot(key: ChainSlotKey, fileName: string): number {
    const ticket = this.bumpVersion(key);
    this.slots[key] = { status: 'loading', fileName };
    this.afterSlotChange();
    return ticket;
  }

  /** 槽位读取/校验失败：只标记该槽，保留其余两槽；ticket 过期则忽略 */
  failSlot(key: ChainSlotKey, fileName: string, errors: string[], ticket?: number): void {
    if (ticket !== undefined && ticket !== this.versions[key]) return;
    this.bumpVersion(key);
    this.slots[key] = { status: 'error', fileName, errors: errors.slice() };
    this.afterSlotChange();
  }

  /** 槽位就绪：撤销旧结论；若三槽均已就绪则启动新的链式任务 */
  readySlot(key: ChainSlotKey, fileName: string, readings: number[], ticket?: number): void {
    if (ticket !== undefined && ticket !== this.versions[key]) return;
    this.bumpVersion(key);
    // 拷贝一份，冻结任务输入，避免调用方后续修改造成别名污染
    this.slots[key] = { status: 'ready', fileName, readings: readings.slice() };
    this.afterSlotChange();
  }

  /** 取消槽位：回到空槽，撤销旧结论并作废在途读取/解析/匹配（版本号使迟到回调失效） */
  clearSlot(key: ChainSlotKey): void {
    this.bumpVersion(key);
    this.slots[key] = { status: 'empty' };
    this.afterSlotChange();
  }

  /**
   * 在当前已成立的拼接方案上执行一次性窗口复核。证据与方案同步绑定：
   * 槽位替换、匹配失败或方案切换都会先清空 review；若调用时状态已变化，
   * 本次结果直接丢弃，避免新序列配上旧位置。非法查询坐标只返回错误，
   * 不改变当前槽位与已成立方案。
   */
  reviewWindow(query: ChainWindowQuery): void {
    const result = this.result;
    if (result === null || result.kind !== 'solution') return;
    if (
      this.slots.A.status !== 'ready' ||
      this.slots.B.status !== 'ready' ||
      this.slots.C.status !== 'ready'
    ) {
      return;
    }

    const slotByKey = { A: this.slots.A, B: this.slots.B, C: this.slots.C };
    const order = result.order.map((key) => CHAIN_SLOT_KEYS.indexOf(key)) as [
      number,
      number,
      number,
    ];
    const slots: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] = [
      slotByKey.A.readings,
      slotByKey.B.readings,
      slotByKey.C.readings,
    ];
    const plan: ChainPlan = {
      order,
      overlap1: result.overlap1,
      overlap2: result.overlap2,
      mergedLength: result.mergedCount,
    };

    const outcome = reviewChainWindow({ slots, plan, query });
    // 提交前再次核验：复核是同步计算，但仍保持与链式任务相同的状态绑定纪律
    if (this.result !== result) return;
    // 长度闸门已经在方案面板说明；不产生一次性证据
    this.review = outcome.kind === 'disabled' ? null : outcome;
    this.publish();
  }

  /**
   * 本地 JSON 入口（与双槽同一契约与数据保护）：
   * 1. beginSlot 立即作废该槽一切在途任务并进入读取中；
   * 2. 已知字节数超 MAX_FILE_BYTES 时读取前直接拒绝，不读入超限文本；
   * 3. 读取文本；读取失败只标记该槽；
   * 4. 把 JSON.parse + 契约整体验证排入调度器：续体执行时若槽位版本已变化
   *    （读取期间被替换或取消），旧续体自行终止，不 parse、不校验，
   *    也绝不 fail/ready 当前槽位或改变其余两槽。
   * 本模块只取用 readings，不调用查询分析；queries 非法同样导致整个文件被拒。
   */
  async loadFileIntoSlot(
    key: ChainSlotKey,
    fileName: string,
    readText: () => Promise<string>,
    options?: { byteSize?: number; parseText?: (text: string) => unknown },
  ): Promise<void> {
    const ticket = this.beginSlot(key, fileName);

    // 读取前规模闸门：超限文件不进入文件读取，诊断有界且可定位
    if (options?.byteSize !== undefined && options.byteSize > MAX_FILE_BYTES) {
      this.failSlot(
        key,
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
      this.failSlot(key, fileName, [`文件读取失败：${errorMessage(e)}`], ticket);
      return;
    }

    // 解析/校验续体经调度器排队：槽位在此期间被替换或取消时，旧续体在执行入口
    // 发现 ticket 过期便自行终止，不再 parse/校验，也不入队任何后续工作。
    const parseText = options?.parseText ?? JSON.parse;
    this.scheduler.schedule(() => {
      if (ticket !== this.versions[key]) return;

      let parsed: unknown;
      try {
        parsed = parseText(text);
      } catch (e) {
        this.failSlot(key, fileName, [`JSON 语法错误，整个文件被拒绝：${errorMessage(e)}`], ticket);
        return;
      }

      const verdict = validateInput(parsed);
      if (!verdict.ok) {
        this.failSlot(key, fileName, verdict.errors, ticket);
        return;
      }
      this.readySlot(key, fileName, verdict.input.readings, ticket);
    });
  }

  private bumpVersion(key: ChainSlotKey): number {
    this.versions[key]++;
    return this.versions[key];
  }

  /** 任何槽位变动的公共后果：撤销旧结论、作废旧任务、必要时启动新链式任务 */
  private afterSlotChange(): void {
    this.activeToken = null; // 旧任务在下一调度点发现身份失效后自行终止
    this.result = null;
    this.review = null;
    const a = this.slots.A;
    const b = this.slots.B;
    const c = this.slots.C;
    if (a.status === 'ready' && b.status === 'ready' && c.status === 'ready') {
      this.startChain(
        [
          { fileName: a.fileName, readings: a.readings },
          { fileName: b.fileName, readings: b.readings },
          { fileName: c.fileName, readings: c.readings },
        ],
      );
    }
    this.publish();
  }

  private startChain(
    ready: [
      { fileName: string; readings: number[] },
      { fileName: string; readings: number[] },
      { fileName: string; readings: number[] },
    ],
  ): void {
    const token: ChainTaskToken = {
      taskId: ++this.taskSeq,
      versionA: this.versions.A,
      versionB: this.versions.B,
      versionC: this.versions.C,
    };
    this.activeToken = token;

    const readings: [number[], number[], number[]] = [
      ready[0].readings,
      ready[1].readings,
      ready[2].readings,
    ];
    const matcher = createChainMatcher(readings);
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

      const plan: ChainPlan | null = matcher.best();
      this.activeToken = null;
      const timingMs = now() - startedAt;
      if (plan === null) {
        this.result = {
          kind: 'none',
          fileNames: [ready[0].fileName, ready[1].fileName, ready[2].fileName],
          timingMs,
        };
      } else {
        const order = plan.order.map((i) => CHAIN_SLOT_KEYS[i]) as [
          ChainSlotKey,
          ChainSlotKey,
          ChainSlotKey,
        ];
        this.result = {
          kind: 'solution',
          order,
          fileNames: plan.order.map((i) => ready[i].fileName) as [string, string, string],
          slotFileNames: [ready[0].fileName, ready[1].fileName, ready[2].fileName],
          counts: plan.order.map((i) => ready[i].readings.length) as [number, number, number],
          overlap1: plan.overlap1,
          overlap2: plan.overlap2,
          mergedCount: plan.mergedLength,
          reviewEnabled: plan.mergedLength <= READINGS_MAX,
          reviewDisabledReason:
            plan.mergedLength > READINGS_MAX
              ? `合成长度 ${plan.mergedLength} 超出原查询索引可承载上限 ${READINGS_MAX}，只禁用窗口复核`
              : undefined,
          head: chainHeadPreview(readings, plan, CONTEXT_MAX),
          tail: chainTailPreview(readings, plan, CONTEXT_MAX),
          timingMs,
        };
      }
      this.publish();
    };

    this.scheduler.schedule(runSlice);
  }

  /** 任务身份核验：令牌仍是在途任务，且三槽版本与启动时一致 */
  private isCurrent(token: ChainTaskToken): boolean {
    return (
      this.activeToken !== null &&
      this.activeToken.taskId === token.taskId &&
      token.versionA === this.versions.A &&
      token.versionB === this.versions.B &&
      token.versionC === this.versions.C
    );
  }

  private derivePhase(): ChainPhase {
    if (this.result) return this.result.kind === 'solution' ? 'chained' : 'no-chain';
    if (this.activeToken) return 'matching';
    const readyCount = CHAIN_SLOT_KEYS.filter((k) => this.slots[k].status === 'ready').length;
    if (readyCount === CHAIN_SLOT_KEYS.length) return 'matching'; // 任务已调度、尚未跑首个分片
    if (readyCount > 0) return 'partial';
    return 'idle';
  }

  private snapshot(): ChainStoreState {
    return {
      slots: { ...this.slots },
      phase: this.derivePhase(),
      result: this.result,
      review: this.review,
      versions: { ...this.versions },
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
