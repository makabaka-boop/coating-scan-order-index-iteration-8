import {
  QUERIES_MAX,
  READINGS_MAX,
  VALUE_MAX,
  VALUE_MIN,
  type Query,
} from './types';

export interface ValidInput {
  readings: number[];
  queries: Query[];
}

/**
 * 单份文件最多保留的逐条错误数。
 * 被拒绝文件只能产生有界且可定位的错误摘要：超过该数量后不再逐条积累，
 * 仅追加一条截断说明，保证诊断规模不随输入长度线性增长。
 */
export const MAX_VALIDATION_ERRORS = 50;

type ValidationOutcome =
  | { ok: true; input: ValidInput; errors: [] }
  | { ok: false; input: null; errors: string[] };

/**
 * 有界错误收集器：
 * - 逐条错误至多保留 MAX_VALIDATION_ERRORS 条（每条都带数组下标，可定位）；
 * - 超出部分只计数，最终折叠成单条截断摘要，错误总数恒为 ≤ 上限 + 1；
 * - 调用方只需照常 push，收集器保证字符串积累不随输入长度增长。
 */
class BoundedErrors {
  private readonly kept: string[] = [];
  private omitted = 0;

  push(message: string): void {
    if (this.kept.length < MAX_VALIDATION_ERRORS) {
      this.kept.push(message);
    } else {
      this.omitted++;
    }
  }

  get hasErrors(): boolean {
    return this.kept.length > 0;
  }

  finish(): string[] {
    if (this.omitted === 0) return this.kept.slice();
    return [
      ...this.kept,
      `错误过多：另有 ${this.omitted} 条同类错误未逐条列出（单份文件至多展示 ${MAX_VALIDATION_ERRORS} 条下标诊断）`,
    ];
  }
}

/**
 * 严格校验载入的 JSON：
 * - 顶层必须是仅含 readings（整数数组）与 queries（对象数组）的对象；
 * - readings 长度 1..200000，每个元素必须是 0..65535 的整数；
 * - queries 长度 0..100000，每个查询必须恰好含 start/end/k 三个整数键，
 *   满足 0≤start<end≤readings.length 且 1≤k≤end-start；
 * - 任何结构或边界错误都拒绝整个文件，错误按数组下标反馈；
 * - 超过契约规模的数组不再逐元素遍历（结构错误本身即可拒绝），
 *   合法规模内的逐条错误也有统一上限（前 50 条可定位，其余折叠为单条摘要），
 *   渲染量与错误字符串总量均不随输入长度线性增长。
 */
export function validateInput(data: unknown): ValidationOutcome {
  const errors = new BoundedErrors();

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return {
      ok: false,
      input: null,
      errors: ['顶层结构错误：文件必须是 JSON 对象，形如 {"readings": [...], "queries": [...]}'],
    };
  }

  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'readings' && key !== 'queries') {
      errors.push(`顶层存在无法识别的键 "${key}"：只允许 readings 与 queries`);
    }
  }

  const rawReadings = obj.readings;
  let readingsLength = 0;
  // 仅当 readings 是长度合规的数组时，才以其长度作为查询区间边界判定依据
  let lengthUsable = false;

  if (!Array.isArray(rawReadings)) {
    errors.push('readings 必须是整数数组');
  } else {
    readingsLength = rawReadings.length;
    if (readingsLength < 1) {
      errors.push('readings[*]：数组至少包含 1 条读数，当前长度为 0');
    } else if (readingsLength > READINGS_MAX) {
      // 超过契约规模即整体拒绝：不再逐元素遍历，
      // 避免 O(输入长度) 的主线程占用与线性增长的诊断
      errors.push(`readings[*]：数组长度 ${readingsLength} 超出上限 ${READINGS_MAX}`);
    } else {
      lengthUsable = true;
      // 数组长度合法（≤ READINGS_MAX）：全量遍历是校验契约的本来成本，
      // 诊断积累由收集器封顶，错误字符串不再随错误数量线性增长
      for (let i = 0; i < rawReadings.length; i++) {
        const v = rawReadings[i];
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          errors.push(`readings[${i}]：必须是整数，当前为 ${describeValue(v)}`);
        } else if (v < VALUE_MIN || v > VALUE_MAX) {
          errors.push(`readings[${i}]：值 ${v} 越界，允许范围为 ${VALUE_MIN}..${VALUE_MAX}`);
        }
      }
    }
  }

  const rawQueries = obj.queries;
  if (!Array.isArray(rawQueries)) {
    errors.push('queries 必须是查询对象数组');
  } else if (rawQueries.length > QUERIES_MAX) {
    // 同样不在超长 queries 上做逐元素遍历
    errors.push(`queries[*]：数组长度 ${rawQueries.length} 超出上限 ${QUERIES_MAX}`);
  } else {
    for (let i = 0; i < rawQueries.length; i++) {
      const q = rawQueries[i];
      if (typeof q !== 'object' || q === null || Array.isArray(q)) {
        errors.push(
          `queries[${i}]：必须是对象，形如 {"start":0,"end":10,"k":1}，当前为 ${describeValue(q)}`,
        );
        continue;
      }

      const qo = q as Record<string, unknown>;
      for (const key of Object.keys(qo)) {
        if (key !== 'start' && key !== 'end' && key !== 'k') {
          errors.push(`queries[${i}]：存在无法识别的键 "${key}"，只允许 start、end、k`);
        }
      }

      const start = integerField(qo, 'start', i, errors);
      const end = integerField(qo, 'end', i, errors);
      const k = integerField(qo, 'k', i, errors);

      // 字段缺失/非整数时不做派生边界检查，避免噪声错误；
      // 读数本身的值非法不影响以其数组长度作为区间边界
      if (start === null || end === null || k === null || !lengthUsable) {
        continue;
      }

      let intervalValid = true;
      if (start < 0 || start >= readingsLength) {
        errors.push(
          `queries[${i}]：start=${start} 越界，要求 0≤start<readings.length(${readingsLength})`,
        );
        intervalValid = false;
      }
      if (end <= 0 || end > readingsLength) {
        errors.push(
          `queries[${i}]：end=${end} 越界，要求 0<end≤readings.length(${readingsLength})`,
        );
        intervalValid = false;
      }
      if (intervalValid && start >= end) {
        errors.push(`queries[${i}]：start=${start} 必须小于 end=${end}（半开区间 [start,end)）`);
        intervalValid = false;
      }
      if (intervalValid && (k < 1 || k > end - start)) {
        errors.push(`queries[${i}]：k=${k} 越界，要求 1≤k≤end-start(${end - start})`);
      }
    }
  }

  if (errors.hasErrors) {
    return { ok: false, input: null, errors: errors.finish() };
  }

  return {
    ok: true,
    input: {
      readings: rawReadings as number[],
      queries: (rawQueries as unknown[]).map((q) => {
        const qo = q as Record<string, unknown>;
        return { start: qo.start as number, end: qo.end as number, k: qo.k as number };
      }),
    },
    errors: [],
  };
}

function integerField(
  qo: Record<string, unknown>,
  name: 'start' | 'end' | 'k',
  index: number,
  errors: BoundedErrors,
): number | null {
  if (!(name in qo)) {
    errors.push(`queries[${index}]：缺少字段 "${name}"`);
    return null;
  }
  const v = qo[name];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    errors.push(`queries[${index}]：字段 "${name}" 必须是整数，当前为 ${describeValue(v)}`);
    return null;
  }
  return v;
}

function describeValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') return `数值 ${v}`;
  if (typeof v === 'string') {
    return `字符串 "${v.length > 20 ? v.slice(0, 20) + '…' : v}"`;
  }
  if (Array.isArray(v)) return `数组(长度 ${v.length})`;
  if (typeof v === 'object') return '对象';
  return String(v);
}
