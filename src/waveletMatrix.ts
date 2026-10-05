/**
 * Wavelet Matrix：针对固定 16 位无符号值域（0..65535）构建。
 *
 * 复杂度（n = readings.length，BITS = 16）：
 * 构建：O(BITS * n) 时间，O(BITS * n) 的分层序列与位前缀和空间
 *   （基础索引约 16*(n+1)*4 字节）；仅当 withSums 为真时再建每层
 *   值前缀和与零段值前缀和（满规模约多 48 MiB）
 * - 区间第 k 小：每查询 O(BITS)，与窗口长度无关
 * - 区间计数（严格小于某值）：与第 k 小同形态的逐层下降 O(BITS)
 * - 区间「中位绝对偏差总量」（需 withSums）：与第 k 小同形态的逐层下降
 *   O(BITS)，不复制窗口、不为窗口另行排序
 *
 * 因此 20 万读数 + 10 万查询的总工作量约为 16*(20万 + 10万) 次常数级操作，
 * 远快于逐窗口复制排序。
 */
import { VALUE_MAX } from './types';

export const BITS = 16;

/** 构造选项：withSums 为真时才额外建立偏差总量所需的值前缀和 */
export interface WaveletOptions {
  withSums?: boolean;
}

/**
 * 单窗口「中位绝对偏差总量」的精确结果：
 * - median：较低中位数（窗口长 len 时第 ⌈len/2⌉ 小，即偶数长取两个中位值中较小者）
 * - deviationTotal：Σ |reading − median|（逐项求和，精确整数）
 */
export interface MedianDeviation {
  median: number;
  deviationTotal: number;
}

export class WaveletMatrix {
  private readonly n: number;
  /** pref[b] 为第 b 层（从高位 BITS-1 到 0）划分前序列的 1 位计数前缀和，长度 n+1 */
  private readonly pref: Int32Array[];
  /** zeroCount[b] 为第 b 层稳定划分后零段的长度 */
  private readonly zeroCount: Int32Array;
  /**
   * sumPref[b] 为第 b 层**划分前**序列的值前缀和，长度 n+1。
   * 逐层下降时 l/r 始终是划分前序列上的连续区间（rank/映射均以 p[l]、p[r]
   * 计算），区间总值直接取本前缀和。
   * 值前缀和最大 n*65535 ≤ 13,107,000,000，超出 Int32 范围但远低于 2^53，
   * 用 Float64Array 承载（按整数精确存取，不做任何展示舍入）。
   */
  private readonly sumPref?: Float64Array[];
  /**
   * zeroSumPref[b] 为第 b 层稳定划分后「零段」的值前缀和，长度 z+1。
   * 区间 [l,r) 内本位为 0 的元素，恰是零段中第 (l−p[l])..(r−p[r]) 个，
   * 故零元素值之和可由本前缀和在 O(1) 取出；壹元素段和则由
   * 区间总和减去零段和得到。
   */
  private readonly zeroSumPref?: Float64Array[];
  private readonly withSums: boolean;

  constructor(values: ArrayLike<number>, options: WaveletOptions = {}) {
    this.n = values.length;
    this.withSums = options.withSums === true;
    const pref: Int32Array[] = new Array(BITS);
    const sumPref: Float64Array[] = this.withSums ? new Array(BITS) : [];
    const zeroSumPref: Float64Array[] = this.withSums ? new Array(BITS) : [];
    const zeroCount = new Int32Array(BITS);

    // 读数值域 0..65535，Uint16Array 精确容纳。
    // 各层前缀和本身就是 Wavelet Matrix 的索引数据组织：
    // 查询沿层下降时直接复用，绝不为单个窗口另行复制排序。
    let cur: Uint16Array = new Uint16Array(this.n);
    for (let i = 0; i < this.n; i++) {
      cur[i] = values[i];
    }

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = new Int32Array(this.n + 1);
      const sp = this.withSums ? new Float64Array(this.n + 1) : null;
      const zeros = new Uint16Array(this.n);
      const ones = new Uint16Array(this.n);
      let z = 0;
      let o = 0;

      if (this.withSums) {
        // 划分前序列上的位计数与值累计；累计量恒为 ≤ n*65535 的精确整数
        let running = 0;
        for (let i = 0; i < this.n; i++) {
          const v = cur[i];
          const bit = (v >>> b) & 1;
          p[i + 1] = p[i] + bit;
          running += v;
          sp![i + 1] = running;
          if (bit === 0) {
            zeros[z++] = v;
          } else {
            ones[o++] = v;
          }
        }

        // 零段顺序上的值前缀和：区间内零元素是它的连续子段
        const zsp = new Float64Array(z + 1);
        let zeroRunning = 0;
        for (let i = 0; i < z; i++) {
          zeroRunning += zeros[i];
          zsp[i + 1] = zeroRunning;
        }
        zeroSumPref[level] = zsp;
        sumPref[level] = sp!;
      } else {
        // 未启用偏差总量时只建第 k 小所需的位前缀和，索引组织与耗时逐位保持原样
        for (let i = 0; i < this.n; i++) {
          const v = cur[i];
          const bit = (v >>> b) & 1;
          p[i + 1] = p[i] + bit;
          if (bit === 0) {
            zeros[z++] = v;
          } else {
            ones[o++] = v;
          }
        }
      }

      pref[level] = p;
      zeroCount[level] = z;

      // 稳定划分：下一层 = 零段拼接壹段
      const next = new Uint16Array(this.n);
      next.set(zeros.subarray(0, z), 0);
      next.set(ones.subarray(0, o), z);
      cur = next;
    }

    this.pref = pref;
    this.zeroCount = zeroCount;
    if (this.withSums) {
      this.sumPref = sumPref;
      this.zeroSumPref = zeroSumPref;
    }
  }

  /**
   * 半开区间 [start, end) 内严格小于 value 的读数数量，与第 k 小同形态的
   * 逐层下降 O(BITS)：每层按 value 在该位的位值决定「该层即被确定为更小」
   * 的整段（壹段或零段，计数由位前缀和 O(1) 给出），再沿与 value 同段
   * 继续下降。value 允许 0..65536（65536 表示大于全部 16 位合法值）：
   * 窗口内数量恰为 rank(65536)−rank(0)，无需为窗口复制排序。
   * 调用方负责保证 0≤start≤end≤n。
   */
  countLess(start: number, end: number, value: number): number {
    if (value <= 0) return 0;
    if (value > VALUE_MAX) return end - start;
    let l = start;
    let r = end;
    let count = 0;

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = this.pref[level];
      const onesL = p[l];
      const onesR = p[r];
      const zerosInRange = r - l - (onesR - onesL);

      if (((value >>> b) & 1) === 0) {
        // value 本位为 0：本位为 1 的元素严格更大，本位为 0 者到后续层再分大小
        l -= onesL;
        r -= onesR;
      } else {
        // value 本位为 1：本位为 0 的元素严格更小，整段计入；其余随 value 进壹段
        count += zerosInRange;
        l = this.zeroCount[level] + onesL;
        r = this.zeroCount[level] + onesR;
      }
    }

    return count;
  }

  /**
   * 半开区间 [start, end) 内的第 k 小值（k 从 1 开始）。
   * 调用方负责保证 0≤start<end≤n 且 1≤k≤end-start。
   */
  kth(start: number, end: number, k: number): number {
    let l = start;
    let r = end;
    let answer = 0;

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = this.pref[level];
      const onesL = p[l];
      const onesR = p[r];
      const zerosInRange = r - l - (onesR - onesL);

      if (k <= zerosInRange) {
        // 进入零段：位置 p 映射为 p - rank1(p)
        l -= onesL;
        r -= onesR;
      } else {
        // 进入壹段：答案该位为 1，位置 p 映射为 zeroCount + rank1(p)
        answer |= 1 << b;
        k -= zerosInRange;
        l = this.zeroCount[level] + onesL;
        r = this.zeroCount[level] + onesR;
      }
    }

    return answer;
  }

  /**
   * 半开区间 [start, end) 的较低中位数，及窗口内每条读数到该中位数的
   * 绝对差之和（中位绝对偏差总量）。必须以 withSums 构造。
   *
   * 中位数是排序后第 ⌈len/2⌉ 小（奇数长为正中位、偶数长为两个中位值中
   * 较低者）。每层把窗口切成「本层为 0」与「本层为 1」两段，中位数沿其中
   * 一段继续下降，另一段所有元素与中位数的大小关系在该位已经确定：
   * - 中位数进零段时，壹段元素必然更大；
   * - 中位数进壹段时，零段元素必然更小。
   * 由于下降途中中位数低位未定，先按「大值取 +v、小值取 −v」登记带符号
   * 值之和与计数（大值计数记 −1、小值计数记 +1），下降结束拿到完整
   * 中位数后合并：total = signedSum + median·signedCount。
   * 段内值之和全部由分层前缀和 O(1) 给出，不复制、不排序任何窗口数据。
   */
  medianDeviation(start: number, end: number): MedianDeviation {
    if (!this.withSums || this.sumPref === undefined || this.zeroSumPref === undefined) {
      throw new Error('medianDeviation 需要以 { withSums: true } 构造 WaveletMatrix');
    }
    const sumPref = this.sumPref;
    const zeroSumPref = this.zeroSumPref;

    let l = start;
    let r = end;
    let k = ((r - l + 1) >> 1); // 较低中位数：⌈len/2⌉
    let median = 0;
    // 偏差总量 = Σ_{v>m}(v−m) + Σ_{v<m}(m−v)
    //          = (Σ大 v − Σ小 v) + m·(#小 − #大)。
    // 下降途中中位数的低位尚未确定，无法逐段乘完整 m，
    // 因此只登记带符号的值之和与计数，最后统一乘以完整中位数：
    // signedSum = Σ大 v − Σ小 v；signedCount = #小 − #大。
    // 各中间量最大 n*65535 ≤ 13,107,000,000（单元素窗口为 0），
    // 远低于 2^53，普通 number 始终精确，无整数溢出。
    let signedSum = 0;
    let signedCount = 0;

    for (let level = 0; level < BITS; level++) {
      const b = BITS - 1 - level;
      const p = this.pref[level];
      const sp = sumPref[level];
      const zsp = zeroSumPref[level];
      // l/r 始终是本层划分前序列上的连续区间
      const onesL = p[l];
      const onesR = p[r];
      const zerosInRange = r - l - (onesR - onesL);
      const onesInRange = r - l - zerosInRange;
      const rangeSum = sp[r] - sp[l];
      // 区间内零元素 = 全局零段的第 [l−onesL, r−onesR) 个
      const zerosSum = zsp[r - onesR] - zsp[l - onesL];

      if (k <= zerosInRange) {
        // 中位数进入零段（中位数本位为 0）：壹段元素本位为 1，必然严格更大
        signedSum += rangeSum - zerosSum;
        signedCount -= onesInRange;

        // 进入零段：位置 p 映射为 p - rank1(p)
        l -= onesL;
        r -= onesR;
      } else {
        // 中位数进入壹段：答案该位为 1；零段元素本位为 0，必然严格更小
        median |= 1 << b;
        signedSum -= zerosSum;
        signedCount += zerosInRange;
        k -= zerosInRange;
        l = this.zeroCount[level] + onesL;
        r = this.zeroCount[level] + onesR;
      }
    }

    // 下降结束后区间内元素全部等于 median，|v−median| = 0，不再计入。
    return { median, deviationTotal: signedSum + signedCount * median };
  }
}
