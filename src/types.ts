/** 读数值域：0..65535（16 位无符号整数） */
export const VALUE_MIN = 0;
export const VALUE_MAX = 65535;
export const READINGS_MAX = 200_000;
export const QUERIES_MAX = 100_000;

/**
 * 扫描文件字节数硬上限（16 MiB），在读取文本前拦截。
 * 契约最坏情况（10 万个最长字段的查询 + 20 万条读数）的紧凑 JSON
 * 也不足 10 MiB，合法文件必然通过；超限文件不得读入内存或参与解析。
 */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** 以中文习惯格式化字节数，供错误提示使用 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** 单个查询，区间按半开 [start, end) 解释 */
export interface Query {
  start: number;
  end: number;
  k: number;
}

/**
 * 复核选项：
 * - includeMad：是否额外计算每个窗口的「中位绝对偏差总量」
 *   （较低中位数 + 窗口内全部读数到该值的绝对差之和）。
 *   默认 false：既有第 k 小结果、统计与拼接流程完全保持原样。
 */
export interface AnalyzeOptions {
  includeMad?: boolean;
}

export interface AnalysisResult {
  ok: boolean;
  /** 读入时的查询总数（失败时为 0） */
  queryCount: number;
  /** 与原 queries 顺序一一对应的第 k 小值；失败时为空数组 */
  answers: number[];
  /**
   * 仅在 includeMad 为真且校验通过时存在：与 answers / queries 顺序一一对应的
   * 「中位绝对偏差总量」Σ|reading − 较低中位数|（精确整数，无展示舍入）。
   * 未启用或失败时恒为 undefined，调用方不得把启用/未启用两份结果混用。
   */
  madTotals?: number[];
  /**
   * 仅在 includeMad 为真且校验通过时存在：madTotals 的逐项总和，
   * 供摘要核对（精确整数，单窗口 ≤ 200000*65535，10 万窗口合计 ≤ 1.31e15，
   * 始终低于 2^53）。
   */
  madSum?: number;
  /** 校验/解析错误，按数组下标反馈；成功时为空 */
  errors: string[];
  /** 统计摘要，便于质检员核对与回归断言 */
  timingMs: number;
  sum: number;
  /** FNV-1a 风格 32 位摘要（取模），对完整答案序列敏感 */
  digest: number;
}
