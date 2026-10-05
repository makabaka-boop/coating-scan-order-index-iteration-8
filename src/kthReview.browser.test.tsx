// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KthReview } from './KthReview';
import { kthBySort, madBySort } from './oracle';
import type { Query } from './types';

/**
 * 浏览器行为测试：以独立预言机（直接排序 + 逐项求和）计算期望值，
 * 核对「切换文件后」页面表格与 CSV 导出逐行一致；
 * 以及失败文件、开关两态下不混用两份数据。
 */

interface Dataset {
  name: string;
  readings: number[];
  queries: Query[];
}

const datasetA: Dataset = {
  name: 'dataset-a.json',
  readings: [120, 55, 31000, 0, 65535, 88, 88, 120, 1, 45000, 77, 77],
  queries: [
    { start: 0, end: 12, k: 1 },
    { start: 0, end: 4, k: 2 },
    { start: 4, end: 8, k: 4 },
    { start: 0, end: 1, k: 1 }, // 单元素窗口：偏差总量必为 0
    { start: 11, end: 12, k: 1 },
    { start: 2, end: 7, k: 3 },
  ],
};

const datasetB: Dataset = {
  name: 'dataset-b.json',
  readings: [5, 1, 4, 2, 8, 3, 7, 6, 65535, 0, 9, 9, 9],
  queries: [
    { start: 0, end: 13, k: 7 },
    { start: 0, end: 5, k: 1 },
    { start: 8, end: 13, k: 5 },
    { start: 3, end: 4, k: 1 },
    { start: 1, end: 6, k: 3 },
  ],
};

function toFile(ds: Dataset): File {
  // 只序列化契约允许的两个键；name 仅用于 File 文件名与测试期望
  return new File(
    [JSON.stringify({ readings: ds.readings, queries: ds.queries })],
    ds.name,
    { type: 'application/json' },
  );
}

/** 预言机口径的期望表格行（第 k 小 + 可选 MAD 总量） */
function expectedRows(ds: Dataset, withMad: boolean) {
  return ds.queries.map((q, i) => {
    const answer = kthBySort(ds.readings, q.start, q.end, q.k);
    const mad = madBySort(ds.readings, q.start, q.end).deviationTotal;
    return { i, q, answer, mad: withMad ? mad : undefined };
  });
}

/** 预言机口径的完整 CSV（含 BOM、CRLF），逐字节比较 */
function expectedCsv(ds: Dataset, withMad: boolean): string {
  const header = withMad
    ? ['query_index', 'start', 'end', 'k', 'window_length', 'kth_value', 'mad_total']
    : ['query_index', 'start', 'end', 'k', 'window_length', 'kth_value'];
  const lines = [header.join(',')];
  for (const { i, q, answer, mad } of expectedRows(ds, withMad)) {
    const base = [i, q.start, q.end, q.k, q.end - q.start, answer];
    lines.push(withMad ? [...base, mad].join(',') : base.join(','));
  }
  return '﻿' + lines.join('\r\n');
}

interface CapturedExport {
  content: string;
  filename: string;
}

/** 拦截 CSV 导出：捕获 Blob 文本（异步读取）与下载文件名 */
function hookCsvExport(): {
  blobs: CapturedExport[];
  /** 点击导出后调用：等待所有在途 Blob 读取落盘到 blobs */
  drain: () => Promise<void>;
} {
  const blobs: CapturedExport[] = [];
  const pending: Promise<void>[] = [];
  let filename = '';

  // jsdom 未实现 createObjectURL / anchor.click，直接打桩
  URL.createObjectURL = vi.fn((obj: Blob | MediaSource) => {
    const blob = obj as Blob;
    pending.push(
      readBlobText(blob).then((content) => {
        blobs.push({ content, filename });
      }),
    );
    return 'blob:mock-url';
  });
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn(function (this: HTMLAnchorElement) {
    filename = this.download;
  }) as HTMLAnchorElement['click'];

  return {
    blobs,
    drain: async () => {
      // 组件在 click 后用 setTimeout(0) 撤销 URL；先让定时器排空，再等 Blob 读取
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.all(pending);
    },
  };
}

/** jsdom 的 Blob 没有 text()；用 readAsArrayBuffer + TextDecoder 读取（保留 UTF-8 BOM） */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // ignoreBOM:true 才能在解码结果中保留开头的 U+FEFF（默认会消费掉 BOM）
      const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
      resolve(decoder.decode(reader.result as ArrayBuffer));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function loadDataset(ds: Dataset): Promise<void> {
  const fileInput = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(fileInput, { target: { files: [toFile(ds)] } });
  await screen.findByRole('heading', {
    level: 2,
    name: new RegExp(ds.name.replace(/\./g, '\\.')),
  });
}

const madCheckbox = () => screen.getByRole('checkbox') as HTMLInputElement;

/** jsdom 的 File 缺少 text()，统一用 FileReader 补上（生产浏览器原生支持） */
function installFileTextPolyfill() {
  (File.prototype as File & { text?: () => Promise<string> }).text = function (
    this: File,
  ) {
    return readBlobText(this);
  };
}

describe('KthReview：中位绝对偏差总量的显示与导出', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 清掉直接打桩的 jsdom 缺失 API，避免跨用例残留
    delete (URL as Partial<typeof URL>).createObjectURL;
    delete (URL as Partial<typeof URL>).revokeObjectURL;
    installFileTextPolyfill();
  });

  it('未启用时保持原样：无 MAD 列、无合计、CSV 也不含 mad_total', async () => {
    const exports = hookCsvExport();
    render(<KthReview />);
    await loadDataset(datasetA);

    expect(screen.queryByText('中位绝对偏差总量')).not.toBeInTheDocument();
    expect(screen.queryByText('偏差总量合计')).not.toBeInTheDocument();
    const table = document.querySelector('table.results') as HTMLTableElement;
    expect(table.querySelectorAll('thead th')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: /^导出 CSV/ }));
    await exports.drain();
    expect(exports.blobs).toHaveLength(1);
    expect(exports.blobs[0].content).toBe(expectedCsv(datasetA, false));
    expect(exports.blobs[0].filename).toBe('kth-review.csv');
  });

  it('启用后表格新增精确总量列，与预言机逐行一致（含单元素窗口=0）', async () => {
    const exports = hookCsvExport();
    render(<KthReview />);
    await loadDataset(datasetA);

    fireEvent.click(madCheckbox());
    await screen.findByText('偏差总量合计');

    const table = document.querySelector('table.results') as HTMLTableElement;
    const headerCells = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headerCells[headerCells.length - 1]).toBe('中位绝对偏差总量');

    const bodyRows = table.querySelectorAll('tbody tr');
    for (const { i, answer, mad } of expectedRows(datasetA, true)) {
      const cells = bodyRows[i].querySelectorAll('td');
      expect(cells[5].textContent).toBe(String(answer));
      expect(cells[6].textContent).toBe(String(mad));
    }
    // 单元素窗口（查询下标 3、4）总量必须精确为 0
    expect(bodyRows[3].querySelectorAll('td')[6].textContent).toBe('0');
    expect(bodyRows[4].querySelectorAll('td')[6].textContent).toBe('0');

    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    await exports.drain();
    expect(exports.blobs[0].content).toBe(expectedCsv(datasetA, true));
    expect(exports.blobs[0].filename).toBe('kth-review-with-mad.csv');
  });

  it('切换到第二份文件后：显示与导出都属于新文件，绝不混入上一份的行或总量', async () => {
    const exports = hookCsvExport();
    render(<KthReview />);
    await loadDataset(datasetA);
    fireEvent.click(madCheckbox());
    await screen.findByText('偏差总量合计');
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    await exports.drain();
    expect(exports.blobs[exports.blobs.length - 1].content).toBe(expectedCsv(datasetA, true));

    // 选择第二份文件（开关保持勾选，按当前勾选状态对新输入整体重算）
    await loadDataset(datasetB);
    await screen.findByText('偏差总量合计');

    const table = document.querySelector('table.results') as HTMLTableElement;
    const bodyRows = table.querySelectorAll('tbody tr');
    for (const { i, answer, mad } of expectedRows(datasetB, true)) {
      const cells = bodyRows[i].querySelectorAll('td');
      expect(cells[0].textContent).toBe(`#${i}`);
      expect(cells[5].textContent).toBe(String(answer));
      expect(cells[6].textContent).toBe(String(mad));
    }

    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    await exports.drain();
    const last = exports.blobs[exports.blobs.length - 1];
    expect(last.content).toBe(expectedCsv(datasetB, true));
    // 导出文本里不得残留 datasetA 特有的读数
    expect(last.content).not.toContain('31000');
    expect(last.filename).toBe('kth-review-with-mad.csv');
  });

  it('关闭开关后列与导出同步消失，第 k 小结果不变', async () => {
    const exports = hookCsvExport();
    render(<KthReview />);
    await loadDataset(datasetB);
    fireEvent.click(madCheckbox());
    await screen.findByText('偏差总量合计');
    fireEvent.click(madCheckbox());
    await waitFor(() => expect(screen.queryByText('偏差总量合计')).not.toBeInTheDocument());

    const table = document.querySelector('table.results') as HTMLTableElement;
    expect(table.querySelectorAll('thead th')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: /^导出 CSV/ }));
    await exports.drain();
    expect(exports.blobs[exports.blobs.length - 1].content).toBe(expectedCsv(datasetB, false));

    for (const { i, answer } of expectedRows(datasetB, false)) {
      const cells = table
        .querySelectorAll('tbody tr')
        [i].querySelectorAll('td');
      expect(cells[5].textContent).toBe(String(answer));
    }
  });

  it('载入非法文件后旧结果与总量整体清除，错误态无导出入口；再载合法文件不混用', async () => {
    const exports = hookCsvExport();
    render(<KthReview />);
    await loadDataset(datasetA);
    fireEvent.click(madCheckbox());
    await screen.findByText('偏差总量合计');

    const bad = new File(
      [JSON.stringify({ readings: [1, 2], queries: [{ start: 0, end: 9, k: 1 }] })],
      'bad.json',
      { type: 'application/json' },
    );
    fireEvent.change(document.querySelector('input[type=file]') as HTMLInputElement, {
      target: { files: [bad] },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('文件被整体拒绝');
    expect(document.querySelector('table.results')).toBeNull();
    expect(screen.queryByText('偏差总量合计')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /导出 CSV/ })).toBeNull();

    // 再载入合法文件 B（开关仍保持勾选）：表格与导出只反映 B、不含 A 的痕迹
    await loadDataset(datasetB);
    await screen.findByText('偏差总量合计');
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    await exports.drain();
    expect(exports.blobs[exports.blobs.length - 1].content).toBe(expectedCsv(datasetB, true));
  });

  it('内置满规模样本启用后，屏幕可见首行与导出首行逐列一致', async () => {
    const exports = hookCsvExport();
    render(<KthReview />);
    fireEvent.click(madCheckbox());
    fireEvent.click(screen.getByRole('button', { name: '载入内置满规模样本' }));
    await screen.findByRole('heading', { level: 2, name: /内置满规模样本/ });

    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    await exports.drain();
    const csv = exports.blobs[exports.blobs.length - 1].content;
    expect(csv.split('\r\n')[0].split(',')).toHaveLength(7);

    const firstDataLine = csv.split('\r\n')[1].split(',');
    const table = document.querySelector('table.results') as HTMLTableElement;
    const firstCells = table.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(firstCells[0].textContent).toBe(`#${firstDataLine[0]}`);
    expect(firstCells[5].textContent).toBe(firstDataLine[5]);
    expect(firstCells[6].textContent).toBe(firstDataLine[6]);
  });
});
