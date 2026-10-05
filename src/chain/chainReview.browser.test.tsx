// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ChainView } from './ChainView';

/**
 * 三段拼接链视图 · 跨接缝窗口一次性复核的浏览器行为测试。
 *
 * 数值正确性由 chainReview.test.ts（逐窗排序 + 独立来源映射预言机）与
 * chainReviewStore.test.ts（绑定/撤销/闸门）保证；此处只核对界面：
 * - 三份文件成立后可输入合成坐标窗口与 k，提交后展示第 k 小、小于/等于
 *   数量、命中合成位置，以及覆盖该位置的全部槽位与原始下标；
 * - 第二道接缝跨过第一道时三条来源同屏列出；
 * - 非法参数给出可定位提示且不顶掉已有证据；
 * - 替换槽位导致方案切换/失败时，旧证据从界面撤销（新序列不配旧位置）。
 */

function toFile(readings: number[], name: string): File {
  return new File([JSON.stringify({ readings, queries: [] })], name, {
    type: 'application/json',
  });
}

/** 第二道接缝跨过第一道的链：合成 [1,2,3,4,5]，位置 1/2 被三份共同覆盖 */
const A = [1, 2, 3];
const B = [2, 3, 4];
const C = [1, 2, 3, 4, 5];

async function loadChain(): Promise<void> {
  const inputs = document.querySelectorAll('input[type=file]');
  expect(inputs).toHaveLength(3);
  fireEvent.change(inputs[0], { target: { files: [toFile(A, 'a.json')] } });
  fireEvent.change(inputs[1], { target: { files: [toFile(B, 'b.json')] } });
  fireEvent.change(inputs[2], { target: { files: [toFile(C, 'c.json')] } });
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: '拼接链成立', level: 2 })).toBeInTheDocument(),
  );
}

function setField(label: string, value: string): void {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

/** 从证据面板的 <dl> 中取某个 <dt> 对应 <dd> 的文本 */
function metricText(panel: HTMLElement, term: string): string {
  const terms = panel.querySelectorAll('dt');
  const defs = panel.querySelectorAll('dd');
  for (let i = 0; i < terms.length; i++) {
    if (terms[i].textContent?.trim() === term) return defs[i].textContent ?? '';
  }
  throw new Error(`未找到指标 ${term}`);
}

describe('ChainView：跨接缝窗口一次性复核', () => {
  it('整窗第 2 小命中位置 1（值 2）：三份来源同屏，原始下标各自正确', async () => {
    render(<ChainView />);
    await loadChain();

    setField('k', '2');
    fireEvent.click(screen.getByRole('button', { name: '执行窗口复核' }));

    const panel = await screen.findByRole('status');
    expect(panel.classList.contains('review-evidence')).toBe(true);
    expect(metricText(panel, '第 k 小值').trim()).toBe('2');
    expect(metricText(panel, '窗口内严格小于')).toContain('1');
    expect(metricText(panel, '窗口内等于')).toContain('1');
    expect(metricText(panel, '命中合成位置').trim()).toBe('1');

    // 三条来源：槽 A 原始下标 1、槽 B 原始下标 0、槽 C 原始下标 1
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    const find = (slot: string) =>
      items.find((li) => (li.textContent ?? '').includes(`槽位 ${slot}`))!;
    expect(find('A').textContent).toContain('a.json');
    expect(find('A').textContent).toContain('原始下标 1');
    expect(find('B').textContent).toContain('b.json');
    expect(find('B').textContent).toContain('原始下标 0');
    expect(find('C').textContent).toContain('c.json');
    expect(find('C').textContent).toContain('原始下标 1');
  });

  it('非法 k：显示可定位提示；修正后成功，已有证据不被非法请求清掉', async () => {
    render(<ChainView />);
    await loadChain();

    setField('k', '99');
    fireEvent.click(screen.getByRole('button', { name: '执行窗口复核' }));
    const alertBox = await screen.findByRole('alert');
    expect(alertBox.textContent).toContain('k=99');
    expect(document.querySelector('.review-evidence')).toBeNull();

    // 修正为合法 k=5（最大值 5，命中位置 4，仅槽 C）
    setField('k', '5');
    fireEvent.click(screen.getByRole('button', { name: '执行窗口复核' }));
    const panel = await screen.findByRole('status');
    expect(metricText(panel, '第 k 小值').trim()).toBe('5');
    expect(metricText(panel, '命中合成位置').trim()).toBe('4');
    expect(within(panel).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('替换槽位导致方案失败：复核证据随结论一起撤销', async () => {
    render(<ChainView />);
    await loadChain();

    setField('k', '2');
    fireEvent.click(screen.getByRole('button', { name: '执行窗口复核' }));
    expect(await screen.findByRole('status')).toBeTruthy();

    // 用接不成链的文件替换槽 A（[7,7,7] 与 B/C 无接触）
    const inputs = document.querySelectorAll('input[type=file]');
    fireEvent.change(inputs[0], { target: { files: [toFile([7, 7, 7], 'a2.json')] } });

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: '无合法拼接顺序', level: 2 }),
      ).toBeInTheDocument(),
    );
    // 结果面板切换为无解，复核区连同证据一起消失
    expect(document.querySelector('.review-evidence')).toBeNull();
    expect(screen.queryByText('跨接缝窗口一次性复核')).toBeNull();
  });

  it('清除证据按钮移除证据但保留拼接结论', async () => {
    render(<ChainView />);
    await loadChain();

    fireEvent.click(screen.getByRole('button', { name: '执行窗口复核' }));
    expect(await screen.findByRole('status')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '清除证据' }));
    await waitFor(() => expect(document.querySelector('.review-evidence')).toBeNull());
    expect(screen.getByRole('heading', { name: '拼接链成立', level: 2 })).toBeInTheDocument();
  });
});
