import { useState } from 'react';
import { KthReview } from './KthReview';
import { SeamView } from './seam/SeamView';
import { ChainView } from './chain/ChainView';

type ViewKey = 'kth' | 'seam' | 'chain';

const VIEW_META: Record<ViewKey, { nav: string; sub: React.ReactNode }> = {
  kth: {
    nav: '第 k 小复核',
    sub: (
      <>
        纯本地运算（Wavelet Matrix），不调用任何业务后端或在线服务。 JSON 含{' '}
        <code>readings</code>（0..65535 整数，1..200000 条）与 <code>queries</code>
        （start/end/k，半开区间 [start,end)，至多 100000 条）。
      </>
    ),
  },
  seam: {
    nav: '扫描片段接缝',
    sub: (
      <>
        分别选择有方向的前段与后段 JSON（仍按 <code>readings</code> / <code>queries</code>{' '}
        契约整体验证），本模块只读取 <code>readings</code>，以 KMP
        前缀函数分片求「前段后缀 ≡ 后段前缀」的最大严格相等长度，不调用查询分析。
      </>
    ),
  },
  chain: {
    nav: '三段拼接链',
    sub: (
      <>
        同一卷读数被分成三份上传、先后次序未知：把三份分别放入三个槽位（仍按{' '}
        <code>readings</code> / <code>queries</code> 契约整体验证，只取 <code>readings</code>
        ），枚举六种有向顺序，逐次以当前合成序列后缀匹配下一份前缀——每道接缝至少重叠 1
        条读数且下一份至少贡献 1 条新读数；取合成长度最短者，完全并列按槽位名称 A→B→C
        裁决。拼接成立后可按合成半开坐标复核跨接缝窗口第 k 小值，并定位全部原始来源。
      </>
    ),
  },
};

/** 顶层导航：第 k 小复核 / 扫描片段接缝 */
export function App() {
  const [view, setView] = useState<ViewKey>('kth');

  return (
    <div className="app">
      <header className="hdr">
        <h1>涂层线扫 · 质检台</h1>
        <nav className="topnav" aria-label="顶层导航">
          {(Object.keys(VIEW_META) as ViewKey[]).map((key) => (
            <button
              key={key}
              className={view === key ? 'nav-btn active' : 'nav-btn'}
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {VIEW_META[key].nav}
            </button>
          ))}
        </nav>
        <p className="sub">{VIEW_META[view].sub}</p>
      </header>

      {view === 'kth' ? <KthReview /> : view === 'seam' ? <SeamView /> : <ChainView />}
    </div>
  );
}
