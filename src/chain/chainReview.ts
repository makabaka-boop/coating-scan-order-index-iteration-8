import { WaveletMatrix } from '../waveletMatrix';
import { CHAIN_REVIEW_MERGED_MAX } from '../types';
import { buildChainSequence, type ChainPlan } from './chainCore';

/**
 * 三段拼接链 · 跨接缝窗口的一次性复核（纯函数核心）。
 *
 * 质检员把三份线扫读数按某个已成立的拼接方案（ChainPlan）拼成整卷后，
 * 需要复核合成序列上任意半开窗口 [start,end)（可跨越一道或两道接缝）的
 * 第 k 小值，并指出它究竟来自哪些原始文件位置。
 *
 * 口径：
 * - 接缝重叠读数在合成序列中只出现一次（chainCore 物化时后续各份跳过
 *   重叠部分），故第 k 小与小于/等于计数天然把重叠读数只计一次；
 * - 第 k 小、窗口内严格小于与等于它的数量全部复用现有 Wavelet Matrix
 *   的精确次序统计（kth / countLess，均为 O(16)），不为窗口复制排序；
 * - 窗口内可能有多个同值读数，按「同值读数按合成位置升序」定位：
 *   取第 k 次出现的那个合成位置，即窗口中第 (lessCount + 1) 个值等于
 *   答案的位置（合成位置从小到大）；
 * - 来源证据列出覆盖该合成位置的所有槽位及各自原始下标：接缝重叠区的
 *   同一位置被前后两份（第二道接缝跨过第一道时可能三份）共同覆盖，
 *   证据槽位按槽位名称顺序（A→B→C）列出；
 * - 复核绑定产生它的拼接方案：来源映射完全由 ChainPlan（顺序 + 两道
 *   接缝长度）决定，调用方（ChainStore）在槽位替换、匹配失败或方案
 *   切换后不得再保留旧证据（新序列不得配旧位置）。
 *
 * 容量：合成长度超过 CHAIN_REVIEW_MERGED_MAX（原查询索引可承载上限，
 * 20 万）时只返回 unavailable——仅禁用此复核，合法拼接不被废弃。
 */

/** 单个槽位对合成位置的来源证据：槽位下标（0=A、1=B、2=C）与其原始下标 */
export interface ChainReviewSource {
  /** 槽位下标（0=A、1=B、2=C，与 ChainPlan.order 的槽位编号一致） */
  readonly slotIndex: number;
  /** 该槽位原始 readings 中与合成位置同值对应的下标 */
  readonly originalIndex: number;
}

/** 一次复核的半开窗口请求：合成序列坐标 [start,end)，k 从 1 开始 */
export interface ChainReviewRequest {
  start: number;
  end: number;
  k: number;
}

/** 复核成功：第 k 小值、窗口内小于/等于数量、定位位置与全部来源证据 */
export interface ChainReviewEvidence {
  readonly kind: 'evidence';
  /** 窗口半开起点（合成序列坐标） */
  readonly start: number;
  /** 窗口半开终点（合成序列坐标） */
  readonly end: number;
  /** 窗口长度 = end − start */
  readonly windowLength: number;
  /** 1 起的次序参数 */
  readonly k: number;
  /** 窗口第 k 小值（精确整数） */
  readonly value: number;
  /** 窗口内严格小于 value 的读数数量（重叠读数只计一次） */
  readonly lessCount: number;
  /** 窗口内等于 value 的读数数量 */
  readonly equalCount: number;
  /**
   * 命中的合成位置：同值读数按合成位置升序时第 k 次出现的位置。
   * （lessCount < k ≤ lessCount+equalCount 恒成立。）
   */
  readonly position: number;
  /** 覆盖命中位置的全部槽位与各自原始下标（按槽位下标升序） */
  readonly sources: readonly ChainReviewSource[];
}

/** 窗口请求非法（边界或整数错误）；不入状态、不产生证据 */
export interface ChainReviewError {
  readonly kind: 'error';
  readonly errors: readonly string[];
}

/** 合成长度超出原查询索引承载上限：只禁用复核，拼接结论保留 */
export interface ChainReviewUnavailable {
  readonly kind: 'unavailable';
  readonly mergedLength: number;
}

export type ChainReviewOutcome =
  | ChainReviewEvidence
  | ChainReviewError
  | ChainReviewUnavailable;

/**
 * 各份在合成序列中的贡献区间。
 * 第一份全量贡献；后续各份的跳过部分是与当前合成序列严格相等的重叠区，
 * 其每个位置同时被相邻槽位覆盖（映射到该槽位 skip 之前的原始下标）。
 *
 * - seg[0]：基 0，贡献 [0, len0)，原始下标 p；
 * - seg[1]：基 len0，贡献 [len0, len0+len1−o1)；
 *   槽位 1 覆盖回退到 [len0−o1, end)，原始下标 p−(len0−o1)；
 * - seg[2]：基 len0+len1−o1，贡献 [base, L)；
 *   槽位 2 覆盖回退到 [base−o2, L)，原始下标 p−(base−o2)。
 *
 * 第二道接缝跨过第一道接缝时 base−o2 < len0，槽位 2 的覆盖区与槽位 0
 * 相交——该位置同时被三份覆盖，三条证据均由下述区间判断自然给出。
 */
interface SegmentMap {
  readonly slotIndex: number;
  readonly length: number;
  /** 该份新读数在合成序列中的起点 */
  readonly base: number;
  /** 该份贡献的重叠长度（第一份为 0） */
  readonly overlap: number;
}

function buildSegmentMaps(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
): [SegmentMap, SegmentMap, SegmentMap] {
  const len0 = slots[plan.order[0]].length;
  const len1 = slots[plan.order[1]].length;
  const base1 = len0;
  const base2 = len0 + len1 - plan.overlap1;
  return [
    { slotIndex: plan.order[0], length: len0, base: 0, overlap: 0 },
    { slotIndex: plan.order[1], length: len1, base: base1, overlap: plan.overlap1 },
    { slotIndex: plan.order[2], length: slots[plan.order[2]].length, base: base2, overlap: plan.overlap2 },
  ];
}

/**
 * 列出覆盖合成位置 p 的所有槽位及各自原始下标（按槽位下标 0→2 升序）。
 * 槽位 s（顺序第 sIdx 份）覆盖 [base−overlap, base+length−overlap)，
 * 原始下标恒为 p−(base−overlap)。
 */
export function chainPositionSources(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
  position: number,
): ChainReviewSource[] {
  const segments = buildSegmentMaps(slots, plan);
  const out: ChainReviewSource[] = [];
  for (let houseOrder = 0; houseOrder < 3; houseOrder++) {
    const seg = segments[houseOrder];
    const coverStart = seg.base - seg.overlap;
    const coverEnd = seg.base + seg.length - seg.overlap;
    if (position >= coverStart && position < coverEnd) {
      out.push({ slotIndex: seg.slotIndex, originalIndex: position - coverStart });
    }
  }
  // 区间按构造顺序（house order）加入；为严格落实「槽位名称顺序」输出，
  // 再按槽位下标排序（同位置每槽至多一条证据）。
  out.sort((a, b) => a.slotIndex - b.slotIndex);
  return out;
}

/**
 * 在合成序列窗口上执行一次性复核。
 *
 * @param slots 槽位 A/B/C（按槽位下标 0/1/2）的已校验读数
 * @param plan  产生当前合成序列的拼接方案
 * @param req   半开窗口与 k（合成序列坐标）
 *
 * 返回：
 * - evidence：复核成功（值、计数、定位位置、全部来源证据）；
 * - error：窗口/k 非法（整数与边界错误），调用方不据此改变任何既有证据；
 * - unavailable：plan.mergedLength 超过 CHAIN_REVIEW_MERGED_MAX。
 */
export function reviewChainWindow(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
  req: ChainReviewRequest,
): ChainReviewOutcome {
  const mergedLength = plan.mergedLength;
  if (mergedLength > CHAIN_REVIEW_MERGED_MAX) {
    return { kind: 'unavailable', mergedLength };
  }

  const { start, end, k } = req;
  const errors: string[] = [];
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

  if (!isInt(start) || !isInt(end) || !isInt(k)) {
    return {
      kind: 'error',
      errors: ['start、end、k 必须为整数（半开窗口 [start,end)，k 从 1 开始）'],
    };
  }
  if (start < 0 || start >= mergedLength) {
    errors.push(`start=${start} 越界，要求 0≤start<合成长度(${mergedLength})`);
  }
  if (end <= 0 || end > mergedLength) {
    errors.push(`end=${end} 越界，要求 0<end≤合成长度(${mergedLength})`);
  }
  if (errors.length === 0 && start >= end) {
    errors.push(`start=${start} 必须小于 end=${end}（半开窗口 [start,end)）`);
  }
  const windowLength = end - start;
  if (errors.length === 0 && (k < 1 || k > windowLength)) {
    errors.push(`k=${k} 越界，要求 1≤k≤end-start(${windowLength})`);
  }
  if (errors.length > 0) return { kind: 'error', errors };

  // 物化合成序列：接缝重叠读数在其中只出现一次。
  // 长度固定且已通过容量闸门（≤ 20 万），物化即复核的全部线性成本；
  // 次序统计本身不复制任何窗口、不为窗口另行排序。
  const sequence = buildChainSequence(slots, plan);

  // 复用现有 Wavelet Matrix 的精确次序统计：
  // 第 k 小 O(16)，严格小于/等于计数是同形态逐层下降的 O(16)
  const wm = new WaveletMatrix(sequence);
  const value = wm.kth(start, end, k);
  const lessCount = wm.countLess(start, end, value);
  const equalCount = wm.countLess(start, end, value + 1) - lessCount;

  // 同值读数按合成位置升序：定位窗口内第 (k−lessCount) 个等于 value 的位置。
  // lessCount < k ≤ lessCount+equalCount 由第 k 小定义保证。
  let wanted = k - lessCount;
  let position = -1;
  for (let p = start; p < end; p++) {
    if (sequence[p] === value) {
      wanted--;
      if (wanted === 0) {
        position = p;
        break;
      }
    }
  }

  // 接缝重叠区的同一位置可被多份共同覆盖：证据列出全部槽位与原始下标
  const sources = chainPositionSources(slots, plan, position);

  // 不变量自检：第 k 小定义保证窗口内至少有 k 个值 ≤ value、其中恰有
  // lessCount 个更小，故第 (k−lessCount) 次出现必然能找到，且命中位置
  // 必落在至少一份贡献区间内。若被错误方案/序列调用，直接抛出而非产出
  // 位置为 −1、来源为空的伪证据。
  if (position < 0 || sources.length === 0) {
    throw new Error('跨接缝窗口复核内部错误：未能定位第 k 小合成位置或其来源');
  }

  return {
    kind: 'evidence',
    start,
    end,
    windowLength,
    k,
    value,
    lessCount,
    equalCount,
    position,
    sources,
  };
}
