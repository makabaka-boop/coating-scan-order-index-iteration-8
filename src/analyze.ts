import { WaveletMatrix } from './waveletMatrix';
import { validateInput } from './validation';
import type { AnalysisResult, AnalyzeOptions } from './types';

/**
 * 解析并复核一份已完成 JSON.parse 的文件内容。
 *
 * 任何结构或边界错误都整体拒绝：返回 ok:false、answers 为空、queryCount 为 0，
 * 由调用方据此清除旧结果。
 *
 * options.includeMad 为真时，在同一张 Wavelet Matrix（额外带值前缀和）上
 * 为每个窗口再做一次同形态的 O(16) 逐层下降，产出「中位绝对偏差总量」
 * （madTotals）与逐项总和（madSum），不复制窗口、不另行排序；
 * 缺省（false）时既有字段、统计与调用流程逐位保持原样。
 */
export function analyze(data: unknown, options: AnalyzeOptions = {}): AnalysisResult {
  const includeMad = options.includeMad === true;

  const verdict = validateInput(data);
  if (!verdict.ok) {
    return {
      ok: false,
      queryCount: 0,
      answers: [],
      errors: verdict.errors,
      timingMs: 0,
      sum: 0,
      digest: 0,
    };
  }

  const { readings, queries } = verdict.input;
  const t0 =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  // 仅在显式启用时才建立偏差总量所需的值前缀和：
  // 未启用时 Wavelet Matrix 的索引组织与构建耗时逐位保持原样
  const wm = new WaveletMatrix(readings, { withSums: includeMad });
  const answers = new Array<number>(queries.length);
  // 答案最大 65535、数量最多 10 万，总和远低于 2^53，普通 number 安全
  let sum = 0;
  // FNV-1a 32 位风格摘要，逐答案写入两个字节，保证结果序列可核对
  let digest = 0x811c9dc5;

  // 仅在显式启用时分配：未启用时结果形状与既有版本完全一致
  const madTotals = includeMad ? new Array<number>(queries.length) : undefined;
  // 单窗口总量 ≤ 窗口长度*65535 ≤ 200000*65535；10 万窗口合计 ≤ 1.31e15 < 2^53
  let madSum = 0;

  for (let i = 0; i < queries.length; i++) {
    const { start, end, k } = queries[i];
    const v = wm.kth(start, end, k);
    answers[i] = v;
    sum += v;
    digest = fnv1aByte(digest, v & 0xff);
    digest = fnv1aByte(digest, (v >>> 8) & 0xff);

    if (madTotals !== undefined) {
      // 复用同一索引数据组织（同一张 Wavelet Matrix 的分层前缀和）：
      // 不复制窗口、不为窗口另行排序，每次下降仍为 O(16)
      const { deviationTotal } = wm.medianDeviation(start, end);
      madTotals[i] = deviationTotal;
      madSum += deviationTotal;
    }
  }

  const t1 =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  const result: AnalysisResult = {
    ok: true,
    queryCount: queries.length,
    answers,
    errors: [],
    timingMs: t1 - t0,
    sum,
    digest: digest >>> 0,
  };
  if (madTotals !== undefined) {
    result.madTotals = madTotals;
    result.madSum = madSum;
  }
  return result;
}

function fnv1aByte(hash: number, byte: number): number {
  return (Math.imul(hash ^ byte, 0x01000193) >>> 0);
}
