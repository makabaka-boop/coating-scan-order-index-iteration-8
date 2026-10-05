import { CONTEXT_MAX, createSeamMatcher, type SeamMatcher } from '../seam/seamCore';

/**
 * 三段拼接链 · 匹配核心。
 *
 * 问题：同一卷读数被分成三份上传，先后次序未知。给定三份有方向读数
 * slots[0..2]，枚举全部 3! = 6 种有向顺序；对每种顺序 (x, y, z)：
 * - 接缝一：x 的后缀与 y 的前缀严格相等，最大长度 o1；
 * - 合成序列 S = x ++ y[o1..]（y 跳过重叠部分后追加）；
 * - 接缝二：S 的后缀与 z 的前缀严格相等，最大长度 o2；
 * - 最终合成 = S ++ z[o2..]。
 *
 * 单道接缝合法当且仅当同时满足：
 * - 至少重叠一条读数：overlap ≥ 1；
 * - 下一份至少贡献一条新读数：overlap < |next|（重叠不能把下一份整个吸收）。
 *
 * 六种顺序均不满足约束时判定「无合法顺序」。合法方案中选取合成长度
 * （|s0|+|s1|+|s2| − o1 − o2）最短者；完全并列时按槽位名称顺序裁决——
 * 排列按下标字典序枚举、严格更短才替换最优，故并列时保留字典序最小者。
 *
 * 实现：每道接缝复用双槽的 KMP 前缀函数匹配器（seamCore），链式任务
 * 同样按可中断分片推进；接缝一合法后先分片物化合成序列，再以其为
 * 前段求接缝二。processed 计数 = 各接缝 KMP 处理元素 + 物化元素之和，
 * 是线性工作量的确定性证据。
 *
 * 前置约定：输入值必须已经过整文件契约校验（0..65535 整数），
 * 调用方（ChainStore）只传入 validateInput 放行后的 readings。
 */

/** 六种有向顺序，按槽位下标字典序排列（0=A、1=B、2=C） */
export const CHAIN_PERMUTATIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** 一条合法接缝方案：最终顺序、两道接缝长度与合成长度 */
export interface ChainPlan {
  /** 最终顺序（槽位下标，0=A、1=B、2=C） */
  readonly order: readonly [number, number, number];
  /** 接缝一：order[0] 后缀 ≡ order[1] 前缀的重叠长度 */
  readonly overlap1: number;
  /** 接缝二：合成序列后缀 ≡ order[2] 前缀的重叠长度 */
  readonly overlap2: number;
  /** 合成长度 = 三份长度之和 − overlap1 − overlap2 */
  readonly mergedLength: number;
}

/** 单道接缝约束：至少重叠一条读数，且下一份至少贡献一条新读数 */
export function isValidJoint(overlap: number, nextLength: number): boolean {
  return overlap >= 1 && overlap < nextLength;
}

export interface ChainMatcher {
  /**
   * 推进至多 budget 个元素（各接缝的 KMP 元素 + 合成序列物化元素）。
   * 返回 true 表示六种顺序全部裁定完毕；完成后重复调用安全地返回 true。
   */
  step(budget: number): boolean;
  /** 已处理的元素总数（接缝扫描 + 合成物化），线性工作量的确定性证据 */
  readonly processed: number;
  /** 是否已完成 */
  readonly done: boolean;
  /** 完成后为最优方案；六种顺序均不合法时为 null */
  best(): ChainPlan | null;
}

export function createChainMatcher(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
): ChainMatcher {
  const total = slots[0].length + slots[1].length + slots[2].length;
  let permIdx = 0;
  // 阶段：0=接缝一（KMP） 1=物化合成序列 2=接缝二（KMP）
  let stage: 0 | 1 | 2 = 0;
  let seam: SeamMatcher | null = null;
  let overlap1 = 0;
  let merged: number[] = [];
  let buildPos = 0;
  let processed = 0;
  let done = false;
  let best: ChainPlan | null = null;

  const advancePerm = (): void => {
    permIdx++;
    stage = 0;
    seam = null;
  };

  // 严格更短才替换：并列时保留先枚举到（槽位名称字典序最小）的方案
  const consider = (
    order: readonly [number, number, number],
    o1: number,
    o2: number,
  ): void => {
    const mergedLength = total - o1 - o2;
    if (best === null || mergedLength < best.mergedLength) {
      best = { order: [order[0], order[1], order[2]], overlap1: o1, overlap2: o2, mergedLength };
    }
  };

  /** 推进当前接缝 matcher，返回是否完成；消耗计入 processed 与 remaining */
  const runSeam = (remaining: number): { finished: boolean; used: number } => {
    const m = seam!;
    const before = m.processed;
    const finished = m.step(remaining);
    return { finished, used: m.processed - before };
  };

  return {
    get processed() {
      return processed;
    },
    get done() {
      return done;
    },
    best() {
      return best;
    },
    step(budget: number): boolean {
      if (done) return true;
      let remaining = Math.max(0, Math.floor(budget));

      while (remaining > 0) {
        if (permIdx >= CHAIN_PERMUTATIONS.length) {
          done = true;
          return true;
        }
        const order = CHAIN_PERMUTATIONS[permIdx];

        if (stage === 0) {
          // 接缝一：order[0] 后缀 ≡ order[1] 前缀
          if (seam === null) seam = createSeamMatcher(slots[order[0]], slots[order[1]]);
          const { finished, used } = runSeam(remaining);
          remaining -= used;
          processed += used;
          if (!finished) return false;
          overlap1 = seam!.overlap();
          seam = null;
          if (!isValidJoint(overlap1, slots[order[1]].length)) {
            advancePerm();
            continue;
          }
          // 接缝一合法：准备物化合成序列 S = x ++ y[o1..]
          merged = new Array<number>(slots[order[0]].length + slots[order[1]].length - overlap1);
          buildPos = 0;
          stage = 1;
          continue;
        }

        if (stage === 1) {
          // 分片物化合成序列（满规模下最长 40 万条，按预算填充）
          const x = slots[order[0]];
          const y = slots[order[1]];
          const cut = x.length - overlap1;
          while (remaining > 0 && buildPos < merged.length) {
            merged[buildPos] = buildPos < cut ? x[buildPos] : y[buildPos - cut];
            buildPos++;
            remaining--;
            processed++;
          }
          if (buildPos < merged.length) return false;
          stage = 2;
          continue;
        }

        // 接缝二：合成序列后缀 ≡ order[2] 前缀
        if (seam === null) seam = createSeamMatcher(merged, slots[order[2]]);
        const { finished, used } = runSeam(remaining);
        remaining -= used;
        processed += used;
        if (!finished) return false;
        const overlap2 = seam!.overlap();
        seam = null;
        if (isValidJoint(overlap2, slots[order[2]].length)) {
          consider(order, overlap1, overlap2);
        }
        advancePerm();
      }
      return false;
    },
  };
}

/** 同步便捷入口：一次性裁定六种顺序，返回最优方案（无合法顺序时为 null） */
export function computeChain(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
): ChainPlan | null {
  const matcher = createChainMatcher(slots);
  while (!matcher.step(1 << 30)) {
    // 预算足够覆盖三份满规模读数的全部接缝与物化工作，循环体实际不会执行
  }
  return matcher.best();
}

/** 合成序列的三段来源：第一份全量，后续各份跳过接缝重叠部分 */
function chainSegments(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
): Array<{ readings: ArrayLike<number>; skip: number }> {
  return [
    { readings: slots[plan.order[0]], skip: 0 },
    { readings: slots[plan.order[1]], skip: plan.overlap1 },
    { readings: slots[plan.order[2]], skip: plan.overlap2 },
  ];
}

/** 物化完整合成序列（长度恒等于 plan.mergedLength），供预览核对与测试使用 */
export function buildChainSequence(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
): number[] {
  const out: number[] = [];
  for (const { readings, skip } of chainSegments(slots, plan)) {
    for (let i = skip; i < readings.length; i++) {
      out.push(readings[i]);
    }
  }
  return out;
}

/** 合成序列开头至多 max 条读数（保持原顺序） */
export function chainHeadPreview(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
  max = CONTEXT_MAX,
): number[] {
  const out: number[] = [];
  for (const { readings, skip } of chainSegments(slots, plan)) {
    for (let i = skip; i < readings.length && out.length < max; i++) {
      out.push(readings[i]);
    }
    if (out.length >= max) break;
  }
  return out;
}

/** 合成序列末尾至多 max 条读数（保持原顺序） */
export function chainTailPreview(
  slots: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  plan: ChainPlan,
  max = CONTEXT_MAX,
): number[] {
  const segments = chainSegments(slots, plan);
  const out: number[] = [];
  for (let s = segments.length - 1; s >= 0 && out.length < max; s--) {
    const { readings, skip } = segments[s];
    // 该段贡献 readings[skip..length)，从尾部截取后拼到已收集部分之前
    const take = Math.min(readings.length - skip, max - out.length);
    const part: number[] = new Array<number>(take);
    for (let i = 0; i < take; i++) {
      part[i] = readings[readings.length - take + i];
    }
    out.unshift(...part);
  }
  return out;
}
