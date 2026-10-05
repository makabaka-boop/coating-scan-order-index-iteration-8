import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { createTimeoutScheduler } from '../seam/seamStore';
import {
  CHAIN_SLOT_KEYS,
  ChainStore,
  type ChainSlotKey,
  type ChainSlotState,
  type ChainStoreState,
  type ChainResult,
} from './chainStore';

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
      void store.loadFileIntoSlot(key, file.name, () => file.text(), { byteSize: file.size });
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

      {state.result && <ChainResultPanel result={state.result} />}
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

function ChainResultPanel({ result }: { result: ChainResult }) {
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
    </section>
  );
}
