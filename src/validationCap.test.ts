import { describe, expect, it } from 'vitest';
import { MAX_VALIDATION_ERRORS, validateInput } from './validation';
import { QUERIES_MAX, READINGS_MAX } from './types';

/**
 * 前置数据保护 · 验收一：被拒绝文件只能产生有界且可定位的错误摘要。
 *
 * - 超长数组（超过契约规模）不得逐元素遍历：结构错误之外不产生线性诊断，
 *   且校验耗时与输入长度脱钩；
 * - 合法规模内的大量错误逐条保留至统一上限，每条带数组下标可定位，
 *   超出部分折叠为单条截断摘要；
 * - 合法上限文件（200000 读数 / 100000 查询）与 queries 整体验证保持兼容。
 */
describe('validateInput：错误摘要有界且可定位，不随输入长度线性增长', () => {
  it('超长 readings：仅报长度错误，不逐元素遍历（含非法元素时同样如此）', () => {
    const readings = new Array(READINGS_MAX + 1).fill(999999); // 全部越界且超长
    const verdict = validateInput({ readings, queries: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');

    const text = verdict.errors.join('\n');
    expect(text).toContain('超出上限');
    expect(text).toContain(String(READINGS_MAX + 1));
    // 超长数组不得产生任何 readings[i] 逐元素诊断
    expect(verdict.errors.some((m) => /readings\[\d+\]/.test(m))).toBe(false);
    expect(verdict.errors.length).toBe(1);
  });

  it('超长 readings 的校验耗时与长度脱钩（500 万元素即时返回）', () => {
    const readings = new Array(5_000_000).fill(-1);
    const t0 = performance.now();
    const verdict = validateInput({ readings, queries: [] });
    const elapsed = performance.now() - t0;
    expect(verdict.ok).toBe(false);
    expect(elapsed).toBeLessThan(200);
  });

  it('超长 queries：仅报长度错误，不逐元素遍历', () => {
    const queries = new Array(QUERIES_MAX + 1).fill(null); // 全部结构非法且超长
    const verdict = validateInput({ readings: [1, 2, 3], queries });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');

    const text = verdict.errors.join('\n');
    expect(text).toContain('超出上限');
    expect(verdict.errors.some((m) => /queries\[\d+\]/.test(m))).toBe(false);
    expect(verdict.errors.length).toBe(1);
  });

  it('超长 queries 的校验耗时与长度脱钩', () => {
    const queries = new Array(2_000_000).fill(null);
    const t0 = performance.now();
    const verdict = validateInput({ readings: [1, 2, 3], queries });
    const elapsed = performance.now() - t0;
    expect(verdict.ok).toBe(false);
    expect(elapsed).toBeLessThan(200);
  });

  it('合法规模内的海量非法 readings：错误封顶，前 50 条下标可定位，超出部分折叠为摘要', () => {
    const readings = new Array(500).fill(999999); // 500 条全部越界，但长度合法
    const verdict = validateInput({ readings, queries: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');

    expect(verdict.errors.length).toBe(MAX_VALIDATION_ERRORS + 1);
    const kept = verdict.errors.slice(0, MAX_VALIDATION_ERRORS);
    // 每条都是可定位的下标诊断，覆盖前 50 个错误位置
    kept.forEach((m, i) => {
      expect(m).toContain(`readings[${i}]`);
    });
    const summary = verdict.errors[MAX_VALIDATION_ERRORS];
    expect(summary).toContain('错误过多');
    expect(summary).toContain('450 条'); // 500 − 50
  });

  it('合法规模内的海量非法 queries：同样封顶并保留下标', () => {
    const queries = new Array(300).fill(null);
    const verdict = validateInput({ readings: [1, 2, 3], queries });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');

    expect(verdict.errors.length).toBe(MAX_VALIDATION_ERRORS + 1);
    expect(verdict.errors[0]).toContain('queries[0]');
    expect(verdict.errors[MAX_VALIDATION_ERRORS - 1]).toContain(
      `queries[${MAX_VALIDATION_ERRORS - 1}]`,
    );
    expect(verdict.errors[MAX_VALIDATION_ERRORS]).toContain('250 条');
  });

  it('readings 与 queries 同时大量非法：跨数组共享同一上限，两侧下标都可定位', () => {
    const readings = new Array(40).fill(-1); // 40 条读数错误
    const queries = new Array(40).fill(null); // 随后 40 条查询错误，共 80
    const verdict = validateInput({ readings, queries });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');

    expect(verdict.errors.length).toBe(MAX_VALIDATION_ERRORS + 1);
    const text = verdict.errors.join('\n');
    expect(text).toContain('readings[0]');
    expect(text).toContain(`readings[39]`);
    expect(text).toContain('queries[0]');
    // 第 40 条起是查询错误，保留到第 50 条 = queries[9]，queries[10] 起折叠
    expect(text).toContain('queries[9]');
    expect(text).not.toContain('queries[10]');
    expect(verdict.errors[MAX_VALIDATION_ERRORS]).toContain('30 条');
  });

  it('恰好 50 条错误：全部保留，不追加截断摘要', () => {
    const readings = new Array(50).fill(65536);
    const verdict = validateInput({ readings, queries: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');
    expect(verdict.errors.length).toBe(MAX_VALIDATION_ERRORS);
    expect(verdict.errors.join('\n')).not.toContain('错误过多');
  });

  it('错误被封顶后仍拒绝整个文件，不产生任何部分答案', () => {
    const readings = new Array(200).fill(1.5);
    const verdict = validateInput({ readings, queries: [] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');
    expect(verdict.input).toBeNull();
  });

  it('合法上限文件保持兼容：200000 读数 + 100000 查询整体验证通过', () => {
    const readings = new Array(READINGS_MAX).fill(0);
    // 全部为最小合法窗口 [0,1) k=1
    const queries = new Array(QUERIES_MAX).fill(0).map(() => ({ start: 0, end: 1, k: 1 }));
    const verdict = validateInput({ readings, queries });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error(`应当合法：${verdict.errors.join('\n')}`);
    expect(verdict.input.readings.length).toBe(READINGS_MAX);
    expect(verdict.input.queries.length).toBe(QUERIES_MAX);
  });

  it('合法规模的 queries 仍整体验证：一个非法区间即整体拒绝', () => {
    const readings = [1, 2, 3, 4, 5];
    const queries = [
      { start: 0, end: 1, k: 1 },
      { start: 0, end: 99, k: 1 }, // end 越界
    ];
    const verdict = validateInput({ readings, queries });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');
    expect(verdict.errors.join('\n')).toContain('queries[1]');
  });

  it('顶层大量非法键同样有界（键枚举在封顶后停止继续 push）', () => {
    const obj: Record<string, number> = { readings: 1, queries: 2 };
    for (let i = 0; i < 5000; i++) obj[`extra${i}`] = i;
    const verdict = validateInput(obj);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('应当整体拒绝');
    expect(verdict.errors.length).toBe(MAX_VALIDATION_ERRORS + 1);
  });
});
