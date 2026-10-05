import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { createTimeoutScheduler } from '../seam/seamStore';
import { CHAIN_REVIEW_MERGED_MAX } from '../types';
import {
  CHAIN_SLOT_KEYS,
  ChainStore,
  type ChainSlotKey,
  type ChainSlotState,
  type ChainStoreState,
  type ChainResult,
  type ChainSolution,
} from './chainStore';
import type { ChainReviewOutcome } from './chainReview';

const SLOT_META: Array<{ key: ChainSlotKey; label: string; role: string }> = [
  { key: 'A', label: '槽位 A', role: '三份之一，次序待定' },
  { key: 'B', label: '槽位 B', role: '三份之一，次序待定' },
  { key: 'C', label: '槽位 C', role: '三份之一，次序待定' },
];

/**
 * 三段拼接链视图。关键不变量：
 * - 文件按 readings/queries 契约整体验证，本模块只把 readings 交给拼接服务，
 *   不调用查询分析，也不渲染既有结果表；
 * - 超过字节上限的文件读取前拒绝；校验错误有统一上限（可定位摘要），
 *   界面永远只渲染有界数量的错误行；
 * - 读取后的解析/校验与链式匹配都在调度点上推进并核验槽位版本，任何时刻都可以
 *   替换或取消任一槽位；变动立即撤销旧结论，旧续体/旧任务的晚到回调不会污染界面。
 */
export function ChainView() {
  const [store] = useState(() => new ChainStore(createTimeoutScheduler()));
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const pick = useCallback(
    (key: ChainSlotKey, file: File) => {
      // 优先用 file.text()；旧环境（File.prototype.text 缺失）退回 FileReader
      const readText =
        typeof file.text === 'function'
          ? () => file.text()
          : () =>
              new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
                reader.readAsText(file);
              });
      void store.loadFileIntoSlot(key, file.name, readText, { byteSize: file.size });
    },
    [store],
  );

  const clear = useCallback((key: ChainSlotKey) => store.clearSlot(key), [store]);

  return (
    <section className="seam">
      <div className="slot-grid">
        {SLOT_META.map(({ key, label, role }) => (
          <SlotCard
            key={key}
            label={label}
            role={role}
            slot={state.slots[key]}
            onPick={(file) => pick(key, file)}
            onClear={() => clear(key)}
          />
        ))}
      </div>

      <PhaseBanner state={state} />

      {state.result && <ChainResultPanel result={state.result} store={store} state={state} />}
    </section>
  );
}

function SlotCard({
  label,
  role,
  slot,
  onPick,
  onClear,
}: {
  label: string;
  role: string;
  slot: ChainSlotState;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onPick(file);
      // 允许再次选择同名文件时重新触发 change
      e.target.value = '';
    },
    [onPick],
  );

  return (
    <div className={`slot-card slot-${slot.status}`}>
      <div className="slot-head">
        <h3>{label}</h3>
        <span className="hint">{role}</span>
      </div>
      <div className="slot-actions">
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          onChange={onChange}
          style={{ display: 'none' }}
        />
        <button className="primary" onClick={() => inputRef.current?.click()}>
          选择 JSON
        </button>
        {slot.status !== 'empty' && (
          <button className="ghost" onClick={onClear}>
            取消此槽
          </button>
        )}
      </div>
      <div className="slot-body">
        {slot.status === 'empty' && <p className="hint">未选择文件</p>}
        {slot.status === 'loading' && (
          <p className="slot-loading">正在读取与校验「{slot.fileName}」……</p>
        )}
        {slot.status === 'ready' && (
          <p className="slot-ok">
            「{slot.fileName}」· {slot.readings.length.toLocaleString('zh-CN')} 条读数
          </p>
        )}
        {slot.status === 'error' && (
          <div className="slot-error" role="alert">
            <p className="slot-error-lead">
              「{slot.fileName}」被整体拒绝（仅标记本槽位，其余槽位保留）：
            </p>
            <ul className="error-list">
              {slot.errors.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function phaseText(state: ChainStoreState): string {
  switch (state.phase) {
    case 'idle':
      return '空闲：请把同一卷的三份扫描片段分别放入三个槽位（次序随意）';
    case 'partial': {
      const ready = CHAIN_SLOT_KEYS.filter((k) => state.slots[k].status === 'ready').length;
      return `已就绪 ${ready}/3：等待全部三份有效载入`;
    }
    case 'matching':
      return '六种有向顺序裁定中……（可随时替换或取消任一槽位，旧任务自动作废）';
    case 'chained':
      return '拼接链成立';
    case 'no-chain':
      return '六种有向顺序均不合法，无法拼接';
  }
}

function PhaseBanner({ state }: { state: ChainStoreState }) {
  return (
    <div className={`phase-banner phase-${state.phase}`}>
      <span className="phase-label">{phaseText(state)}</span>
      <span className="hint">
        每道接缝要求「前一段后缀 ≡ 后一段前缀」至少重叠 1 条读数，且后一段至少贡献 1
        条新读数；合成长度最短者胜出，完全并列时按槽位名称 A→B→C 顺序裁决。
      </span>
    </div>
  );
}

function ChainResultPanel({
  result,
  store,
  state,
}: {
  result: ChainResult;
  store: ChainStore;
  state: ChainStoreState;
}) {
  if (result.kind === 'none') {
    return (
      <section className="panel seam-result seam-none">
        <h2>无合法拼接顺序</h2>
        <p className="hint">
          三份文件（{result.fileNames.join('、')}）均通过契约校验，但六种有向顺序中
          没有任何一种能让两道接缝同时成立：每道接缝都要求前一段后缀与后一段前缀
          至少重叠 1 条读数，且后一段至少贡献 1 条新读数。请核对三份片段是否来自
          同一卷、方向是否一致。裁定耗时 {result.timingMs.toFixed(1)} ms。
        </p>
      </section>
    );
  }

  return (
    <section className="panel seam-result seam-ok">
      <h2>拼接链成立</h2>
      <div className="chain-order">
        {result.order.map((key, i) => (
          <span key={key} className="chain-node">
            {i > 0 && <span className="chain-arrow">→</span>}
            <span className="chip hit">{key}</span>
            <span className="file-name">{result.fileNames[i]}</span>
            <span className="hint">{result.counts[i].toLocaleString('zh-CN')} 条</span>
          </span>
        ))}
      </div>
      <dl className="metrics">
        <div>
          <dt>接缝一（{result.order[0]} → {result.order[1]}）</dt>
          <dd>{result.overlap1.toLocaleString('zh-CN')} 条重叠</dd>
        </div>
        <div>
          <dt>接缝二（合成 → {result.order[2]}）</dt>
          <dd>{result.overlap2.toLocaleString('zh-CN')} 条重叠</dd>
        </div>
        <div>
          <dt>合成长度</dt>
          <dd>
            {result.mergedCount.toLocaleString('zh-CN')}
            <span className="formula">
              = {result.counts[0].toLocaleString('zh-CN')} +{' '}
              {result.counts[1].toLocaleString('zh-CN')} +{' '}
              {result.counts[2].toLocaleString('zh-CN')} −{' '}
              {result.overlap1.toLocaleString('zh-CN')} −{' '}
              {result.overlap2.toLocaleString('zh-CN')}
            </span>
          </dd>
        </div>
        <div>
          <dt>裁定耗时</dt>
          <dd>{result.timingMs.toFixed(1)} ms</dd>
        </div>
      </dl>

      <div className="context-row">
        <div className="context-block">
          <h4>合成预览 · 开头（至多 8 条）</h4>
          <div className="chips">
            {result.head.map((v, i) => (
              <span key={i} className="chip hit">
                {v}
              </span>
            ))}
          </div>
        </div>
        <div className="context-block">
          <h4>合成预览 · 末尾（至多 8 条）</h4>
          <div className="chips">
            {result.tail.map((v, i) => (
              <span key={i} className="chip hit">
                {v}
              </span>
            ))}
          </div>
        </div>
      </div>

      <ChainReviewPanel solution={result} store={store} state={state} />
    </section>
  );
}

/**
 * 跨接缝窗口一次性复核面板。
 *
 * 证据只来自 store.state.review（store 在任何槽位变动/方案切换时即撤销），
 * 因此面板绝不保留自己的旧证据副本：方案一变，提交时返回错误、已展示证据
 * 也随重渲染消失。表单参数只是输入，不构成任何跨方案证据。
 */
function ChainReviewPanel({
  solution,
  store,
  state,
}: {
  solution: ChainSolution;
  store: ChainStore;
  state: ChainStoreState;
}) {
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState(String(solution.mergedCount));
  const [k, setK] = useState('1');
  const [formError, setFormError] = useState<string[] | null>(null);

  // 方案切换（order/文件/合成长度变化）后旧证据必然已被 store 撤销；
  // 这里同步把表单重置到新合成序列的整卷窗口，避免参数残留误导。
  const solutionKey = `${solution.order.join('')}|${solution.fileNames.join('|')}|${solution.mergedCount}`;
  const lastKeyRef = useRef(solutionKey);
  if (lastKeyRef.current !== solutionKey) {
    lastKeyRef.current = solutionKey;
    setStart('0');
    setEnd(String(solution.mergedCount));
    setK('1');
    setFormError(null);
  }

  const unavailable = solution.mergedCount > CHAIN_REVIEW_MERGED_MAX;

  const submit = useCallback(() => {
    const outcome: ChainReviewOutcome = store.reviewWindow({
      start: Number(start),
      end: Number(end),
      k: Number(k),
    });
    if (outcome.kind === 'error') {
      setFormError([...outcome.errors]);
    } else {
      setFormError(null);
    }
  }, [store, start, end, k]);

  const review = state.review;
  const evidence = review?.evidence ?? null;

  return (
    <div className="chain-review">
      <h3>跨接缝窗口一次性复核</h3>
      <p className="hint">
        按合成序列半开坐标 <code>[start, end)</code> 输入窗口与 k（1 起），复用单文件第 k
        小的同一张 Wavelet Matrix 精确次序统计：返回第 k 小值、窗口内严格小于及等于它的数量，
        并按「同值读数按合成位置升序」定位命中位置。接缝重叠读数只计一次；来源证据列出
        覆盖该位置的全部槽位及各自原始下标（含第二道接缝跨过第一道时三份同证）。证据绑定
        当前拼接方案——替换任一槽位、匹配失败或切换方案立即撤销。
      </p>

      {unavailable ? (
        <p className="review-unavailable" role="status">
          合成长度 {solution.mergedCount.toLocaleString('zh-CN')} 超出原查询索引承载上限{' '}
          {CHAIN_REVIEW_MERGED_MAX.toLocaleString('zh-CN')}：仅禁用此一次性复核，
          上方拼接结论与头尾预览仍然有效。
        </p>
      ) : (
        <>
          <form
            className="review-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label>
              start
              <input
                type="number"
                value={start}
                min={0}
                max={solution.mergedCount - 1}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              end
              <input
                type="number"
                value={end}
                min={1}
                max={solution.mergedCount}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
            <label>
              k
              <input type="number" value={k} min={1} onChange={(e) => setK(e.target.value)} />
            </label>
            <button className="primary" type="submit">
              执行窗口复核
            </button>
            {evidence && (
              <button className="ghost" type="button" onClick={() => store.clearReview()}>
                清除证据
              </button>
            )}
          </form>
          <p className="hint">
            合成坐标范围 0..{solution.mergedCount.toLocaleString('zh-CN')}（半开右端可取{' '}
            {solution.mergedCount.toLocaleString('zh-CN')}）。
          </p>

          {formError && (
            <div className="review-error" role="alert">
              <ul className="error-list">
                {formError.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </div>
          )}

          {evidence && (
            <div className="review-evidence" role="status">
              <dl className="metrics">
                <div>
                  <dt>窗口 [start, end)</dt>
                  <dd>
                    [{evidence.start}, {evidence.end}) · 长 {evidence.windowLength.toLocaleString('zh-CN')} · k=
                    {evidence.k}
                  </dd>
                </div>
                <div>
                  <dt>第 k 小值</dt>
                  <dd>{evidence.value}</dd>
                </div>
                <div>
                  <dt>窗口内严格小于</dt>
                  <dd>{evidence.lessCount.toLocaleString('zh-CN')} 条</dd>
                </div>
                <div>
                  <dt>窗口内等于</dt>
                  <dd>{evidence.equalCount.toLocaleString('zh-CN')} 条</dd>
                </div>
                <div>
                  <dt>命中合成位置</dt>
                  <dd>{evidence.position.toLocaleString('zh-CN')}</dd>
                </div>
              </dl>
              <h4>来源证据（覆盖该合成位置的全部槽位与原始下标，按槽位 A→B→C）</h4>
              <ul className="review-sources">
                {evidence.sources.map((src) => {
                  const key = CHAIN_SLOT_KEYS[src.slotIndex];
                  const orderPos = solution.order.indexOf(key);
                  const fileName = solution.fileNames[orderPos];
                  return (
                    <li key={key}>
                      <span className="chip hit">槽位 {key}</span>
                      <span className="file-name">{fileName}</span>
                      <span className="hint">原始下标 {src.originalIndex.toLocaleString('zh-CN')}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
