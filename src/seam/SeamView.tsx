import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import {
  createTimeoutScheduler,
  SeamStore,
  type SeamStoreState,
  type SlotSide,
  type SlotState,
} from './seamStore';

const SIDE_META: Array<{ side: SlotSide; label: string; role: string }> = [
  { side: 'left', label: '前段', role: '提供后缀参与接缝' },
  { side: 'right', label: '后段', role: '提供前缀参与接缝' },
];

/**
 * 扫描片段接缝视图。关键不变量：
 * - 文件按 readings/queries 契约整体验证，本模块只读取 readings，
 *   不调用查询分析，也不渲染既有结果表；
 * - 超过字节上限的文件读取前拒绝；校验错误有统一上限（可定位摘要），
 *   界面永远只渲染有界数量的错误行；
 * - 读取后的解析/校验与匹配都在调度点上推进并核验槽位版本，任何时刻都可以
 *   替换任一槽位；替换立即撤销旧结论，旧续体/旧任务的晚到回调不会污染界面。
 */
export function SeamView() {
  const [store] = useState(() => new SeamStore(createTimeoutScheduler()));
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = useCallback(() => store.getState(), [store]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const pick = useCallback(
    (side: SlotSide, file: File) => {
      void store.loadFileIntoSlot(side, file.name, () => file.text(), { byteSize: file.size });
    },
    [store],
  );

  return (
    <section className="seam">
      <div className="slot-grid">
        {SIDE_META.map(({ side, label, role }) => (
          <SlotCard
            key={side}
            label={label}
            role={role}
            slot={side === 'left' ? state.left : state.right}
            onPick={(file) => pick(side, file)}
          />
        ))}
      </div>

      <PhaseBanner state={state} />

      {state.result && <SeamResultPanel result={state.result} />}
    </section>
  );
}

function SlotCard({
  label,
  role,
  slot,
  onPick,
}: {
  label: string;
  role: string;
  slot: SlotState;
  onPick: (file: File) => void;
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
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        onChange={onChange}
        style={{ display: 'none' }}
      />
      <button className="primary" onClick={() => inputRef.current?.click()}>
        选择{label} JSON
      </button>
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
              「{slot.fileName}」被整体拒绝（仅标记本槽位，另一槽位保留）：
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

function phaseText(state: SeamStoreState): string {
  switch (state.phase) {
    case 'idle':
      return '空闲：请分别选择有方向的前段与后段 JSON 文件';
    case 'one-sided':
      return '单侧已载入：等待另一侧文件就绪';
    case 'matching':
      return '双侧匹配中……（可随时替换任一槽位，旧任务自动作废）';
    case 'seam':
      return '接缝成立';
    case 'no-overlap':
      return '无重叠';
  }
}

function PhaseBanner({ state }: { state: SeamStoreState }) {
  return (
    <div className={`phase-banner phase-${state.phase}`}>
      <span className="phase-label">{phaseText(state)}</span>
      <span className="hint">
        仅「前段后缀 ≡ 后段前缀」的严格相等计入接缝；反向相等、内部重复、
        未接触两端的相似段均不算。
      </span>
    </div>
  );
}

function SeamResultPanel({ result }: { result: NonNullable<SeamStoreState['result']> }) {
  // 上下文中属于接缝的条数：末尾/开头各至多展示 8 条，重叠超过 8 条时全部高亮
  const tailHit = Math.min(result.overlap, result.leftTail.length);
  const headHit = Math.min(result.overlap, result.rightHead.length);

  return (
    <section className={`panel seam-result ${result.overlap > 0 ? 'seam-ok' : 'seam-none'}`}>
      <h2>{result.overlap > 0 ? '接缝成立' : '无重叠'}</h2>
      <dl className="metrics">
        <div>
          <dt>前段文件</dt>
          <dd className="file-name">{result.leftFileName}</dd>
        </div>
        <div>
          <dt>后段文件</dt>
          <dd className="file-name">{result.rightFileName}</dd>
        </div>
        <div>
          <dt>重叠长度</dt>
          <dd>{result.overlap.toLocaleString('zh-CN')}</dd>
        </div>
        <div>
          <dt>去重拼接长度</dt>
          <dd>
            {result.mergedCount.toLocaleString('zh-CN')}
            <span className="formula">
              = {result.leftCount.toLocaleString('zh-CN')} +{' '}
              {result.rightCount.toLocaleString('zh-CN')} −{' '}
              {result.overlap.toLocaleString('zh-CN')}
            </span>
          </dd>
        </div>
        <div>
          <dt>匹配耗时</dt>
          <dd>{result.timingMs.toFixed(1)} ms</dd>
        </div>
      </dl>

      <div className="context-row">
        <ContextList
          title="前段末尾（至多 8 条）"
          values={result.leftTail}
          hitStart={result.leftTail.length - tailHit}
          hitCount={tailHit}
        />
        <ContextList
          title="后段开头（至多 8 条）"
          values={result.rightHead}
          hitStart={0}
          hitCount={headHit}
        />
      </div>
    </section>
  );
}

function ContextList({
  title,
  values,
  hitStart,
  hitCount,
}: {
  title: string;
  values: number[];
  hitStart: number;
  hitCount: number;
}) {
  return (
    <div className="context-block">
      <h4>{title}</h4>
      <div className="chips">
        {values.map((v, i) => {
          const isHit = hitCount > 0 && i >= hitStart && i < hitStart + hitCount;
          return (
            <span key={i} className={isHit ? 'chip hit' : 'chip'}>
              {v}
            </span>
          );
        })}
      </div>
    </div>
  );
}
