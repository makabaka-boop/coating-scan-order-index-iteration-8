/**
 * 扫描片段接缝 · 匹配核心。
 *
 * 目标：给定有方向的前段 left 与后段 right，求「left 后缀与 right 前缀
 * 严格相等」的最大长度 L（0 ≤ L ≤ min(|left|, |right|)）。
 * 只有同时接触 left 末端与 right 首端的相等段才算接缝：
 * 反向相等、内部重复、未接触两端的相似段都不会被计入。
 *
 * 算法：KMP 前缀函数。概念上把模式串视为 right 后接一个值域外哨兵
 * （SENTINEL = -1，任何合法读数 0..65535 都不会与之相等），
 * 再扫描 left 一遍；扫描结束时的前缀函数状态即为答案。
 * - 时间：O(|left| + |right|)（均摊线性）；
 * - 辅助空间：O(|right|)，仅存放 right 自身的前缀函数表；
 * - 可中断分片：每个分片延续 (piPos, piK, scanPos, k) 状态，
 *   其中 k 由哨兵界定、永远不超过 |right|。
 *
 * 前置约定：输入值必须已经过整文件契约校验（0..65535 整数），
 * 调用方（SeamStore）只传入 validateInput 放行后的 readings。
 */

/** 值域外哨兵：严格小于一切合法读数，保证与任何读数比较都不相等 */
export const SENTINEL = -1;

/** 结果区上下文展示的条数上限（前段末尾 / 后段开头各自） */
export const CONTEXT_MAX = 8;

export interface SeamMatcher {
  /**
   * 推进至多 budget 个元素（right 的前缀函数表项 + left 的扫描位置）。
   * 返回 true 表示匹配完成；完成后重复调用安全地返回 true 且不再改变状态。
   */
  step(budget: number): boolean;
  /** 已处理的元素总数：完成时恒等于 (|right|-1) + |left|，是线性工作量的确定性证据 */
  readonly processed: number;
  /** 是否已完成 */
  readonly done: boolean;
  /** 完成时为最终重叠长度；未完成时为当前前缀函数状态（中间值） */
  overlap(): number;
}

export function createSeamMatcher(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): SeamMatcher {
  const n = left.length;
  const m = right.length;
  // pi[i]：right[0..i] 的最长真 border 长度（right 与自身错位匹配的前缀函数）
  const pi = new Int32Array(m);
  let piPos = 1; // 下一个待计算的 pi 下标（pi[0] 恒为 0）
  let piK = 0; // 计算前缀函数时的当前匹配长度
  let scanPos = 0; // left 的扫描下标
  let k = 0; // 扫描 left 时的前缀函数状态：已处理后缀与 right 前缀的匹配长度
  let processed = 0;
  let done = false;

  // 模式串在 right 之外的概念延伸：哨兵与任何合法读数都不相等，
  // 因此 k === m 时下一步必然沿 pi 回退，状态被界定在 [0, m] 内
  const patternAt = (i: number): number => (i < m ? right[i] : SENTINEL);

  return {
    get processed() {
      return processed;
    },
    get done() {
      return done;
    },
    overlap() {
      return k;
    },
    step(budget: number): boolean {
      if (done) return true;
      let remaining = Math.max(0, Math.floor(budget));

      // 阶段一：right 自身的前缀函数（KMP 自匹配）
      while (remaining > 0 && piPos < m) {
        const c = right[piPos];
        while (piK > 0 && right[piK] !== c) piK = pi[piK - 1];
        if (right[piK] === c) piK++;
        pi[piPos] = piK;
        piPos++;
        processed++;
        remaining--;
      }
      if (piPos < m) return false;

      // 阶段二：扫描 left，延续由值域外哨兵界定的前缀函数状态
      while (remaining > 0 && scanPos < n) {
        const c = left[scanPos];
        while (k > 0 && patternAt(k) !== c) k = pi[k - 1];
        if (patternAt(k) === c) k++;
        scanPos++;
        processed++;
        remaining--;
      }
      if (scanPos < n) return false;

      done = true;
      return true;
    },
  };
}

/** 同步便捷入口：一次性求 left 后缀与 right 前缀的最大严格相等长度 */
export function computeSeamOverlap(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): number {
  const matcher = createSeamMatcher(left, right);
  while (!matcher.step(1 << 30)) {
    // 预算足够覆盖 20 万 + 20 万，循环体实际不会执行
  }
  return matcher.overlap();
}

/** 前段末尾至多 max 条读数（保持原顺序） */
export function tailContext(values: ArrayLike<number>, max = CONTEXT_MAX): number[] {
  const take = Math.min(max, values.length);
  const out = new Array<number>(take);
  for (let i = 0; i < take; i++) {
    out[i] = values[values.length - take + i];
  }
  return out;
}

/** 后段开头至多 max 条读数（保持原顺序） */
export function headContext(values: ArrayLike<number>, max = CONTEXT_MAX): number[] {
  const take = Math.min(max, values.length);
  const out = new Array<number>(take);
  for (let i = 0; i < take; i++) {
    out[i] = values[i];
  }
  return out;
}
