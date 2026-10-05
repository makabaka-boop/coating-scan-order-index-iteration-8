import { READINGS_MAX } from '../types';
import { WaveletMatrix } from '../waveletMatrix';
import { buildChainSequence, type ChainPlan } from './chainCore';

/**
 * 三段拼接成功后的一次性窗口复核。
 *
 * 复核只对已裁定的 ChainPlan 生效：统计使用该方案物化出的去重合成序列，
 * 因此接缝重叠读数即使同时来自多份原始文件，也只作为一个合成位置计数。
 * 证据映射与统计分开计算：被选中的合成位置若落在接缝重叠区，会列出覆盖
 * 该位置的全部槽位及原始下标，包括第二道接缝回跨第一道接缝的情形。
 */

export interface ChainWindowQuery {
  start: number;
  end: number;
  k: number;
}

/** 一个合成位置的来源证据；重叠位置可能同时返回多条 */
export interface ChainSourceRef {
  /** 槽位下标：0=A、1=B、2=C */
  slot: 0 | 1 | 2;
  /** 该槽原始 readings 中的下标（从 0 开始） */
  originalIndex: number;
  /** 冗余记录该位置读数值，供证据与合成序列逐位核对 */
  value: number;
}

export interface ChainWindowReview {
  kind: 'review';
  start: number;
  end: number;
  k: number;
  /** 窗口长度（接缝重叠读数只计一次） */
  windowLength: number;
  /** Wavelet Matrix 精确次序统计得到的第 k 小值 */
  kthValue: number;
  /** kthValue 的语义别名，便于调用方直接读取 value */
  value: number;
  /** 窗口内严格小于 kthValue 的去重读数数量 */
  lessCount: number;
  /** 窗口内等于 kthValue 的去重读数数量 */
  equalCount: number;
  /** 同值读数按合成位置升序时，第 k 个被选中的合成位置 */
  position: number;
  /** 覆盖 position 的全部槽位/原始下标；按槽位 A→C 排列 */
  sources: ChainSourceRef[];
}

export type ChainReviewResult =
  | ChainWindowReview
  | { kind: 'disabled'; reason: string }
  | { kind: 'error'; errors: string[] };

export interface ChainReviewInput {
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
  plan: ChainPlan;
  query: ChainWindowQuery;
}

function slotKey(slot: number): 0 | 1 | 2 {
  if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error(`非法槽位下标：${slot}`);
  return slot;
}

/** 校验查询坐标并返回有界错误；不触碰任何旧复核证据 */
export function validateChainWindowQuery(
  start: number,
  end: number,
  k: number,
  mergedLength: number,
): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(start)) errors.push('start 必须是整数');
  if (!Number.isInteger(end)) errors.push('end 必须是整数');
  if (!Number.isInteger(k)) errors.push('k 必须是整数');
  if (errors.length > 0) return errors;

  if (start < 0 || end > mergedLength || start >= end) {
    errors.push(
      `窗口必须满足 0≤start<end≤合成长度（当前合成长度 ${mergedLength}），收到 [${start}, ${end})`,
    );
  }
  const length = end - start;
  if (k < 1 || k > length) {
    errors.push(`k 必须满足 1≤k≤窗口长度（当前窗口长度 ${length}），收到 k=${k}`);
  }
  return errors;
}

/**
 * 返回合成位置 position 的全部来源。证据来自槽位对最终合成的实际贡献段，
 * 并额外补回被两道接缝跳过的重叠前缀：
 * - 第一道接缝位置由 order[0]/order[1] 共同覆盖；
 * - 第二道接缝位置由合成前两段与 order[2] 共同覆盖；
 * - 第二道接缝若回跨第一道接缝，则该位置最多可由三份共同覆盖。
 */
export function chainSourcesAt(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
  position: number,
): ChainSourceRef[] {
  if (!Number.isInteger(position) || position < 0 || position >= plan.mergedLength) {
    throw new Error(`合成位置越界：${position} / ${plan.mergedLength}`);
  }

  const [s0, s1, s2] = [plan.order[0], plan.order[1], plan.order[2]];
  const cut0 = slots[s0].length;
  const cut1 = cut0 + slots[s1].length - plan.overlap1;
  const sources: ChainSourceRef[] = [];
  const add = (slot: number, originalIndex: number): void => {
    const value = slots[slot][originalIndex];
    sources.push({ slot: slotKey(slot), originalIndex, value });
  };

  if (position < cut0) {
    add(s0, position);
    // 第一道接缝：首份末尾 overlap1 个位置对应次份前缀
    if (position >= cut0 - plan.overlap1) {
      add(s1, position - (cut0 - plan.overlap1));
    }
  } else if (position < cut1) {
    add(s1, position - cut0 + plan.overlap1);
  } else {
    add(s2, position - cut1 + plan.overlap2);
  }

  // 第二道接缝区间是 [cut1−overlap2, cut1)；final third segment 中的 z[overlap2..]
  // 已由上面的贡献分支列出，不能再按重叠前缀重复登记。
  const seam2Start = cut1 - plan.overlap2;
  if (position >= seam2Start && position < cut1) {
    add(s2, position - seam2Start);
  }

  sources.sort((a, b) => a.slot - b.slot || a.originalIndex - b.originalIndex);
  return sources;
}

/**
 * 独立来源映射预言机/测试辅助：为每个合成位置生成来源列表。
 * 直接从三段贡献段和两道接缝的区间关系构建，不依赖窗口复核实现。
 */
export function buildChainSourceMap(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
): ChainSourceRef[][] {
  const out: ChainSourceRef[][] = Array.from({ length: plan.mergedLength }, () => []);
  const [s0, s1, s2] = [plan.order[0], plan.order[1], plan.order[2]];
  const cut0 = slots[s0].length;
  const cut1 = cut0 + slots[s1].length - plan.overlap1;
  const seam2Start = cut1 - plan.overlap2;

  const put = (position: number, slot: number, originalIndex: number): void => {
    if (
      out[position].some(
        (source) => source.slot === slot && source.originalIndex === originalIndex,
      )
    ) {
      return;
    }
    out[position].push({ slot: slotKey(slot), originalIndex, value: slots[slot][originalIndex] });
  };

  for (let i = 0; i < slots[s0].length; i++) put(i, s0, i);
  for (let i = plan.overlap1; i < slots[s1].length; i++) {
    put(cut0 + i - plan.overlap1, s1, i);
  }
  for (let i = 0; i < plan.overlap1; i++) put(cut0 - plan.overlap1 + i, s1, i);
  for (let i = plan.overlap2; i < slots[s2].length; i++) {
    put(cut1 + i - plan.overlap2, s2, i);
  }
  for (let i = 0; i < plan.overlap2; i++) put(seam2Start + i, s2, i);

  for (const refs of out) refs.sort((a, b) => a.slot - b.slot || a.originalIndex - b.originalIndex);
  return out;
}

/** 对已绑定的拼接方案执行一次窗口复核；方案不合长度闸门时仅禁用复核 */
export function reviewChainWindow(input: ChainReviewInput): ChainReviewResult {
  const { slots, plan, query } = input;
  if (plan.mergedLength > READINGS_MAX) {
    return {
      kind: 'disabled',
      reason: `合成长度 ${plan.mergedLength} 超出原查询索引可承载上限 ${READINGS_MAX}，仅禁用窗口复核，合法拼接仍然保留`,
    };
  }

  const errors = validateChainWindowQuery(query.start, query.end, query.k, plan.mergedLength);
  if (errors.length > 0) return { kind: 'error', errors };

  // 每个方案物化自己的序列并建立 Wavelet Matrix；调用方替换槽位后必须重新裁定、
  // 重新调用本函数，不能把旧方案返回的位置用于新序列。
  const sequence = buildChainSequence(slots, plan);
  const wm = new WaveletMatrix(sequence);
  const { value, position } = wm.kthPosition(query.start, query.end, query.k);
  return {
    kind: 'review',
    start: query.start,
    end: query.end,
    k: query.k,
    windowLength: query.end - query.start,
    kthValue: value,
    value,
    lessCount: wm.countLess(query.start, query.end, value),
    equalCount: wm.countEqual(query.start, query.end, value),
    position,
    sources: chainSourcesAt(slots, plan, position),
  };
}
