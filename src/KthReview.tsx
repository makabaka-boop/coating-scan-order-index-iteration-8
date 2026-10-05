import { useCallback, useMemo, useRef, useState } from 'react';
import { analyze } from './analyze';
import { generateFullScale } from './sampleGenerator';
import { MAX_FILE_BYTES, formatByteSize } from './types';
import type { AnalysisResult, Query } from './types';

interface LoadedPayload {
  fileName: string;
  readingsCount: number;
  queries: Query[];
  result: AnalysisResult;
  /**
   * 已通过整体校验的原始输入对象。切换可选项时只在同一份 source 上整体重算，
   * 新文件载入 / 校验失败会整体替换 view，旧 source 与旧结果同时消失，
   * 统计、摘要、表格与导出永远只引用同一个 payload。
   */
  source: { readings: number[]; queries: Query[] };
}

type ViewState =
  | { status: 'idle' }
  | { status: 'busy'; fileName: string }
  | { status: 'error'; fileName: string; errors: string[] }
  | { status: 'ready'; payload: LoadedPayload };

/**
 * 第 k 小复核台。关键不变量：
 * 每次重新选文件/载入样本都先清空旧视图，再处理新内容；
 * 只有全部校验通过才渲染答案，任何非法文件只显示错误、绝不留下部分答案；
 * 答案按 queries 原顺序一一对应展示，显式打印查询下标，杜绝相邻窗口错位；
 * 可选「中位绝对偏差总量」与第 k 小同源于同一次 analyze 结果，
 * 启用/关闭均整体重算，绝不把两份结果拼在一起展示或导出。
 */
export function KthReview() {
  const [view, setView] = useState<ViewState>({ status: 'idle' });
  const [includeMad, setIncludeMad] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const consumeObject = useCallback((obj: unknown, fileName: string, withMad: boolean) => {
    // analyze 内部保证：失败时 answers/madTotals 均为空，调用方据此清除旧结果
    const result = analyze(obj, { includeMad: withMad });
    if (!result.ok) {
      setView({ status: 'error', fileName, errors: result.errors });
      return;
    }
    const source = obj as { readings: number[]; queries: Query[] };
    setView({
      status: 'ready',
      payload: {
        fileName,
        readingsCount: source.readings.length,
        queries: source.queries,
        result,
        source,
      },
    });
  }, []);

  const handleFile = useCallback(
    async (file: File, withMad: boolean) => {
      // 先清除旧结果（含上一份成功答案），再进入新文件处理
      setView({ status: 'busy', fileName: file.name });
      // 读取前规模闸门：超限文件不读入内存，诊断有界
      if (file.size > MAX_FILE_BYTES) {
        setView({
          status: 'error',
          fileName: file.name,
          errors: [
            `文件过大：${formatByteSize(file.size)} 超出 ${formatByteSize(MAX_FILE_BYTES)} 上限，读取前拒绝`,
          ],
        });
        return;
      }
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setView({
            status: 'error',
            fileName: file.name,
            errors: [`JSON 语法错误，整个文件被拒绝：${msg}`],
          });
          return;
        }
        consumeObject(parsed, file.name, withMad);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setView({ status: 'error', fileName: file.name, errors: [`文件读取失败：${msg}`] });
      }
    },
    [consumeObject],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleFile(file, includeMad);
      // 允许再次选择同名文件时重新触发 change
      e.target.value = '';
    },
    [handleFile, includeMad],
  );

  const loadFullScaleSample = useCallback(
    (withMad: boolean) => {
      setView({ status: 'busy', fileName: '内置满规模样本（200000 读数 / 100000 查询）' });
      // 让 busy 有机会绘制后再做重计算
      setTimeout(() => {
        const sample = generateFullScale();
        consumeObject(sample, '内置满规模样本（200000 读数 / 100000 查询）', withMad);
      }, 16);
    },
    [consumeObject],
  );

  // 切换可选项：以当前成功载入的同一份输入整体重算。
  // 只对同一 payload.source 重新 analyze，完成后原子替换整个 payload；
  // 任何新文件载入 / 查询失败都会走另一路径整体替换 view，
  // 因此启用与未启用两份结果绝不可能被拼在同一张表或同一份导出里。
  const toggleMad = useCallback(() => {
    const next = !includeMad;
    setIncludeMad(next);
    setView((current) => {
      if (current.status !== 'ready') return current;
      const { fileName, source } = current.payload;
      const rebuilt = analyze(source, { includeMad: next });
      if (!rebuilt.ok) {
        // 同一已通过整体校验的数据不可能再次失败：原样返回，绝不留下半成品
        return current;
      }
      return {
        status: 'ready',
        payload: {
          fileName,
          readingsCount: source.readings.length,
          queries: source.queries,
          result: rebuilt,
          source,
        },
      };
    });
  }, [includeMad]);

  return (
    <>
      <section className="loader">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={onInputChange}
          style={{ display: 'none' }}
        />
        <button className="primary" onClick={() => fileInputRef.current?.click()}>
          选择 JSON 文件
        </button>
        <button onClick={() => loadFullScaleSample(includeMad)}>载入内置满规模样本</button>
        <label className="option-toggle">
          <input
            type="checkbox"
            checked={includeMad}
            onChange={toggleMad}
            disabled={view.status !== 'ready'}
          />
          <span>
            同时核对中位绝对偏差总量
            <span className="formula">
              半开窗口取较低中位数（第 ⌈len/2⌉ 小），精确求 Σ|读数−中位数|
            </span>
          </span>
        </label>
        <span className="hint">文件全程仅在本机浏览器中读取与计算</span>
      </section>

      {view.status === 'busy' && (
        <section className="panel busy">正在解析与复核「{view.fileName}」……</section>
      )}

      {view.status === 'error' && (
        <section className="panel error" role="alert">
          <h2>文件被整体拒绝：{view.fileName}</h2>
          <p className="error-lead">
            以下结构或边界错误导致整个文件被拒，未产生任何查询答案；如之前有旧结果也已清除。
          </p>
          <ul className="error-list">
            {view.errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </section>
      )}

      {view.status === 'ready' && (
        <ResultsTable payload={view.payload} madEnabled={includeMad} />
      )}

      {view.status === 'idle' && (
        <section className="panel idle">
          尚未载入文件。选择 JSON 文件，或直接载入内置的确定性满规模样本进行验收。
        </section>
      )}
    </>
  );
}

/** 导出 CSV 的列定义，保证页面表格与导出文件逐行逐列同源 */
interface ExportRow {
  index: number;
  start: number;
  end: number;
  k: number;
  length: number;
  answer: number;
  madTotal?: number;
}

function toExportRows(queries: Query[], answers: number[], madTotals?: number[]): ExportRow[] {
  return queries.map((q, i) => {
    const row: ExportRow = {
      index: i,
      start: q.start,
      end: q.end,
      k: q.k,
      length: q.end - q.start,
      answer: answers[i],
    };
    if (madTotals !== undefined) row.madTotal = madTotals[i];
    return row;
  });
}

/**
 * 生成 CSV 文本：全部整数按十进制原样写出（不经 toFixed/toLocaleString），
 * 加 UTF-8 BOM 防止中文表头在表格软件里乱码。
 */
function buildCsv(rows: ExportRow[], withMad: boolean): string {
  const header = withMad
    ? ['query_index', 'start', 'end', 'k', 'window_length', 'kth_value', 'mad_total']
    : ['query_index', 'start', 'end', 'k', 'window_length', 'kth_value'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const base = [r.index, r.start, r.end, r.k, r.length, r.answer];
    lines.push(withMad ? [...base, r.madTotal].join(',') : base.join(','));
  }
  return '﻿' + lines.join('\r\n');
}

function ResultsTable({ payload, madEnabled }: { payload: LoadedPayload; madEnabled: boolean }) {
  const { fileName, readingsCount, queries, result } = payload;
  const madTotals = madEnabled ? result.madTotals : undefined;
  const exportRows = useMemo(
    () => toExportRows(queries, result.answers, madTotals),
    [queries, result.answers, madTotals],
  );

  const exportCsv = useCallback(() => {
    // 导出直接由当前 payload 派生，和屏幕表格、摘要同一份数据
    const csv = buildCsv(exportRows, madEnabled);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kth-review${madEnabled ? '-with-mad' : ''}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 释放放在下一帧，确保某些浏览器完成下载启动
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [exportRows, madEnabled]);

  return (
    <section className="panel ready">
      <div className="summary">
        <h2>复核完成：{fileName}</h2>
        <dl className="metrics">
          <div><dt>读数条数</dt><dd>{readingsCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>查询条数</dt><dd>{result.queryCount.toLocaleString('zh-CN')}</dd></div>
          <div><dt>计算耗时</dt><dd>{result.timingMs.toFixed(1)} ms</dd></div>
          <div><dt>答案总和</dt><dd>{result.sum.toLocaleString('zh-CN')}</dd></div>
          <div><dt>摘要 FNV-1a</dt><dd>{result.digest.toString(16).padStart(8, '0')}</dd></div>
          {madEnabled && (
            <div>
              <dt>偏差总量合计</dt>
              <dd>{(result.madSum ?? 0).toLocaleString('zh-CN')}</dd>
            </div>
          )}
        </dl>
        {madEnabled && (
          <p className="mad-note">
            每行总量为窗口内全部读数到其较低中位数的绝对差之和，
            按精确整数展示与导出（单元素窗口为 0）；该列与第 k 小结果同属本次查询结果。
          </p>
        )}
      </div>

      {result.queryCount === 0 ? (
        <p className="empty-queries">queries 为空：文件合法，但没有需要复核的查询。</p>
      ) : (
        <VirtualTable
          queries={queries}
          answers={result.answers}
          madTotals={madTotals}
          onExportCsv={exportCsv}
        />
      )}
    </section>
  );
}

const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 560;
const OVERSCAN = 12;

/**
 * 仅渲染视口附近约 30 行，支撑 10 万行结果不卡顿；
 * 行的查询下标直接来自数组下标，首尾相邻窗口不会出现任何错位。
 * 启用偏差核对时新增的列与第 k 小列同源于一个 answers/madTotals 下标。
 */
function VirtualTable({
  queries,
  answers,
  madTotals,
  onExportCsv,
}: {
  queries: Query[];
  answers: number[];
  madTotals?: number[];
  onExportCsv: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const total = queries.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);

  const rows = useMemo(() => {
    const items: Array<{ i: number; q: Query; a: number; mad?: number }> = [];
    for (let i = startIndex; i < endIndex; i++) {
      items.push({
        i,
        q: queries[i],
        a: answers[i],
        mad: madTotals === undefined ? undefined : madTotals[i],
      });
    }
    return items;
  }, [startIndex, endIndex, queries, answers, madTotals]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const jump = useCallback(
    (target: number) => {
      const el = scrollRef.current;
      if (el) {
        const clamped = Math.max(0, Math.min(target, total - 1)) * ROW_HEIGHT;
        el.scrollTop = clamped;
        setScrollTop(clamped);
      }
    },
    [total],
  );

  return (
    <div className="table-wrap">
      <div className="table-toolbar">
        <button onClick={() => jump(0)}>首行 (#0)</button>
        <button onClick={() => jump(total - 1)}>末行 (#{(total - 1).toLocaleString('zh-CN')})</button>
        <button className="export-btn" onClick={onExportCsv}>
          导出 CSV{madTotals !== undefined ? '（含偏差总量）' : ''}
        </button>
        <span className="hint">
          当前可见 #{startIndex.toLocaleString('zh-CN')} – #{(endIndex - 1).toLocaleString('zh-CN')}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="viewport"
        onScroll={onScroll}
        style={{ height: VIEWPORT_HEIGHT }}
      >
        <div className="spacer" style={{ height: total * ROW_HEIGHT }}>
          <table className="results" style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}>
            <thead>
              <tr>
                <th className="col-idx">查询下标</th>
                <th>start</th>
                <th>end</th>
                <th>k</th>
                <th>窗口长度</th>
                <th className="col-ans">第 k 小值（精确）</th>
                {madTotals !== undefined && <th className="col-mad">中位绝对偏差总量</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ i, q, a, mad }) => (
                <tr key={i}>
                  <td className="col-idx mono">#{i}</td>
                  <td className="mono">{q.start}</td>
                  <td className="mono">{q.end}</td>
                  <td className="mono">{q.k}</td>
                  <td className="mono">{q.end - q.start}</td>
                  <td className="col-ans mono strong">{a}</td>
                  {madTotals !== undefined && <td className="col-mad mono">{mad}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
