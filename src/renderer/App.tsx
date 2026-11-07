import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowDownUp, ArrowUpRight, Check, CheckCircle2, ChevronRight, Disc3, Download, Globe, Headphones, Heart, Info, Library, Link2, Loader2, Mic2, Music2, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, Upload, X } from 'lucide-react';
import { exactDate } from '../core/matcher.js';
import { itemKey, kindLabels, kinds, labels, mappingTitle, platforms, type Kind, type Mapping, type MusicItem, type Platform } from '../core/models.js';
import type { AppView, DesktopAPI, SearchResult } from '../shared/api.js';

type Page = 'library' | 'preview' | 'mappings' | 'apple' | 'settings';
const api = window.msync;
const pageTitles: Record<Page, string> = { library: '音乐收藏', preview: '同步预览', mappings: '对应关系', apple: 'Apple Music 网页确认', settings: '账户与设置' };
function Brand({ platform, small = false }: { platform: Platform; small?: boolean }) {
  return <span className={`brand brand-${platform}${small ? ' small' : ''}`} aria-label={labels[platform]}>{platform === 'spotify' ? <span className="spotify-waves">≋</span> : platform === 'appleMusic' ? <Music2 size={small ? 13 : 22} /> : <span className="netease-mark">N</span>}</span>;
}
function Cover({ item, size = '' }: { item: MusicItem; size?: string }) {
  const hue = Array.from(item.release?.title ?? item.title).reduce((value, letter) => value + letter.charCodeAt(0), 0) % 4;
  return <div className={`cover cover-${hue} ${size}`} aria-hidden="true"><span className="cover-orbit" /><span className="cover-line" /><span className="cover-letter">{(item.release?.title ?? item.title).slice(0, 1)}</span></div>;
}
function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close(): void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-label={title} className={`modal ${wide ? 'wide' : ''}`} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header><h2>{title}</h2><button className="icon-button" onClick={close} aria-label="关闭"><X size={20} /></button></header>{children}
  </dialog>;
}
function ItemFacts({ item }: { item: MusicItem }) {
  return <div className="facts"><div><span>艺人</span><strong>{item.artists.join('、') || '待核实'}</strong></div>
    {item.release && <><div><span>所属发行</span><strong>{item.release.title}</strong></div><div><span>发行日期</span><strong>{item.release.date?.value ?? '未提供完整日期'}</strong></div></>}
    {item.isrc && <div><span>ISRC</span><strong className="mono">{item.isrc}</strong></div>}
    {item.trackNumber && <div><span>曲序</span><strong>{item.trackNumber}</strong></div>}
  </div>;
}
export default function App() {
  const [view, setView] = useState<AppView>();
  const [page, setPage] = useState<Page>('library');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { if (api) api.getState().then(setView).catch(error => setError(String(error.message))); }, []);
  async function run<T>(work: () => Promise<T>, after?: (result: T) => void): Promise<void> {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { const result = await work(); after?.(result); }
    catch (error) { setError(error instanceof Error ? error.message : '操作未完成，请重试'); }
    finally { setBusy(false); }
  }
  const update = (work: () => Promise<AppView>): Promise<void> => run(work, setView);
  if (!api) return <div className="startup"><Music2 size={42} /><h1>MSync</h1><p>请从桌面应用启动，以连接本机同步服务。</p></div>;
  if (!view) return <div className="startup"><Loader2 className="spin" size={32} /><p>{error || '正在打开你的音乐收藏…'}</p></div>;
  const navigation = [
    { id: 'library' as Page, title: '音乐收藏', icon: Library }, { id: 'preview' as Page, title: '同步预览', icon: ArrowDownUp },
    { id: 'mappings' as Page, title: '对应关系', icon: Link2 }, { id: 'apple' as Page, title: '网页确认', icon: Globe }
  ];
  return <div className="app-shell">
    <aside className="sidebar"><div className="wordmark"><div className="logo"><AudioLogo /></div><span>msync<span className="wordmark-dot">.</span></span></div>
      <div className="sidebar-caption">你的音乐，连接在一起</div>
      <nav aria-label="主导航">{navigation.map(({ id, title, icon: Icon }) => <button key={id} className={page === id ? 'nav-item active' : 'nav-item'} onClick={() => setPage(id)}><Icon size={19} /><span>{title}</span>{id === 'preview' && !!view.plan?.operations.length && <b>{view.plan.operations.length}</b>}</button>)}</nav>
      <div className="sidebar-divider" /><div className="sidebar-label">音乐平台</div>
      {view.connections.map(connection => <button className="sidebar-platform" key={connection.platform} onClick={() => setPage('settings')}><Brand platform={connection.platform} small /><span>{labels[connection.platform]}</span><i className={connection.connected ? 'status-dot online' : 'status-dot'} /></button>)}
      <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={17} /><div>在本机管理收藏<span>{view.credentialStorage === 'secure' ? '登录凭据通过系统安全存储保护' : '登录凭据仅在本次运行中保留'}</span></div></div>
        <button className={page === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('settings')}><Settings2 size={19} /><span>账户与设置</span></button>
        <div className="version">MSync <span>0.2.0</span></div>
      </div>
    </aside>
    <main className="workspace"><div className="topbar"><div className="breadcrumb">工作空间<ChevronRight size={14} /><strong>{pageTitles[page]}</strong></div><div className="topbar-actions"><span className="device-label">{view.os === 'darwin' ? 'Mac' : view.os === 'win32' ? 'Windows' : 'Linux'} 本机</span><button className="button subtle compact" disabled={busy} onClick={() => run(() => api.exportBackup(), saved => { if (saved) setNotice('备份已导出，不包含登录凭据。'); })}><Download size={15} />导出备份</button></div></div>
      <div className="content">
        {view.demo && <div className="demo-banner"><Play size={15} /><span><strong>离线演示</strong>　当前展示示例收藏，所有操作只影响示例数据。</span><button disabled={busy} onClick={() => update(() => api.demoMode(false))}>退出演示<X size={13} /></button></div>}
        {error && <div role="alert" className="alert error"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><X size={15} /></button></div>}
        {notice && <div role="status" className="alert success"><CheckCircle2 size={18} /><span>{notice}</span></div>}
        {page === 'library' && <LibraryPage view={view} api={api} busy={busy} run={run} update={update} setPage={setPage} setView={setView} />}
        {page === 'preview' && <PreviewPage view={view} api={api} busy={busy} run={run} update={update} setView={setView} setNotice={setNotice} />}
        {page === 'mappings' && <MappingsPage view={view} api={api} busy={busy} update={update} />}
        {page === 'apple' && <ApplePage view={view} api={api} busy={busy} update={update} run={run} setPage={setPage} />}
        {page === 'settings' && <SettingsPage view={view} api={api} busy={busy} run={run} update={update} setView={setView} setNotice={setNotice} error={error} />}
      </div>
      <footer className="statusbar"><span className={busy ? 'status-dot working' : 'status-dot online'} /><span>{busy ? '正在处理，请稍候…' : view.message}</span><span className="statusbar-right">{view.state.mappings.length} 组已确认对应关系</span></footer>
    </main>
  </div>;
}
function AudioLogo() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>; }
type Props = { view: AppView; api: DesktopAPI; busy: boolean; update(work: () => Promise<AppView>): Promise<void>; run<T>(work: () => Promise<T>, after?: (result: T) => void): Promise<void> };
function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></div>;
}
function LibraryPage({ view, api, busy, run, update, setPage, setView }: Props & { setPage(page: Page): void; setView(view: AppView): void }) {
  const [platform, setPlatform] = useState<Platform>('spotify'), [kind, setKind] = useState<Kind>('track');
  const [query, setQuery] = useState(''), [selected, setSelected] = useState<string>();
  const [searching, setSearching] = useState<MusicItem>(), [target, setTarget] = useState<Platform>('appleMusic');
  const [results, setResults] = useState<SearchResult[]>([]), [review, setReview] = useState<{ source: MusicItem; target: MusicItem }>();
  const snapshot = view.snapshots.find(snapshot => snapshot.platform === platform && snapshot.kind === kind);
  const items = useMemo(() => (snapshot?.items ?? []).filter(item => snapshot?.savedIDs.includes(item.id) && (!query || `${item.title} ${item.artists.join(' ')} ${item.release?.title ?? ''}`.toLowerCase().includes(query.toLowerCase()))), [snapshot, query]);
  const item = items.find(item => itemKey(item) === selected);
  const stats = (platform: Platform, kind: Kind): number => view.snapshots.find(snapshot => snapshot.platform === platform && snapshot.kind === kind)?.savedIDs.length ?? 0;
  function openSearch(source: MusicItem) { setSearching(source); setResults([]); setTarget(platforms.find(platform => platform !== source.platform) ?? 'appleMusic'); }
  return <>
    <PageHeader eyebrow="YOUR MUSIC, EVERYWHERE" title="收藏好音乐，不必重复收藏。" description="以 Spotify 为主要收藏平台，让每一次添加与取消都有迹可循。" actions={<button className="button primary" disabled={busy} onClick={() => update(() => api.scan())}><RefreshCw size={17} className={busy ? 'spin' : ''} />扫描收藏</button>} />
    <div className="platform-grid">{view.connections.map(connection => <button key={connection.platform} className={`platform-card ${platform === connection.platform ? 'selected' : ''}`} onClick={() => { setPlatform(connection.platform); setSelected(undefined); }}>
      <div className="platform-card-top"><Brand platform={connection.platform} /><div><h3>{labels[connection.platform]}</h3><span>{connection.mode}</span></div><span className={connection.connected ? 'connection-tag online' : 'connection-tag'}>{connection.connected ? connection.platform === 'appleMusic' && !view.demo ? '已启用' : '已连接' : '未连接'}</span></div>
      <div className="platform-stats"><div><strong>{stats(connection.platform, 'track')}</strong><span>歌曲</span></div><div><strong>{stats(connection.platform, 'album')}</strong><span>专辑</span></div><div><strong>{stats(connection.platform, 'artist')}</strong><span>艺人</span></div></div>
    </button>)}</div>
    <div className="library-heading"><div className="tabs" aria-label="收藏类型">{kinds.map(value => <button key={value} className={value === kind ? 'active' : ''} onClick={() => { setKind(value); setSelected(undefined); }}><KindIcon kind={value} />{kindLabels[value]}</button>)}</div><label className="search-field"><Search size={16} /><input aria-label="搜索收藏" placeholder="搜索歌曲、艺人或专辑" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    <div className="library-body"><section className="library-list" aria-label="收藏列表">
      <div className="table-head"><span className="number">#</span><span>标题 / 艺人</span><span className="release-column">所属发行</span><span className="match-column">对应关系</span></div>
      {items.length ? items.map((item, index) => { const mapping = view.state.mappings.find(mapping => mapping.items.some(mapped => itemKey(mapped) === itemKey(item))); return <button key={itemKey(item)} className={`music-row ${selected === itemKey(item) ? 'selected' : ''}`} onClick={() => setSelected(itemKey(item))}><span className="row-number">{String(index + 1).padStart(2, '0')}</span><div className="row-title"><Cover item={item} /><div><strong>{item.title}</strong><span>{item.artists.join('、')}</span></div></div><div className="row-release"><span>{item.release?.title ?? '—'}</span><small>{item.release?.date?.value ?? ''}</small></div><div className="row-mapping">{mapping ? <><Check size={13} /><span>已确认</span></> : <span className="muted">待核实</span>}</div></button>; }) : <div className="empty-state"><div className="empty-icon"><Headphones size={33} /></div><h2>{snapshot ? '这里还没有收藏' : '从连接你的音乐开始'}</h2><p>{snapshot ? '试试切换平台或收藏类型，也可以在平台添加收藏后重新扫描。' : '连接账户后扫描收藏，或者先用示例数据了解同步流程。'}</p><div><button className="button secondary" onClick={() => setPage('settings')}>连接音乐平台<ArrowUpRight size={15} /></button>{!view.demo && <button className="button subtle" disabled={busy} onClick={() => update(() => api.demoMode(true))}><Play size={15} />体验离线演示</button>}</div></div>}
      <div className="list-footer">{items.length} 项{snapshot && !snapshot.isComplete ? ' · 部分可读，未读取的状态保持未知' : snapshot ? ' · 完整扫描' : ' · 等待扫描'}</div>
    </section><aside className="detail-panel">{item ? <><div className="detail-cover"><Cover item={item} size="large" /><span className="floating-platform"><Brand platform={item.platform} small /></span></div><h2>{item.title}</h2><p>{item.artists.join('、')}</p><ItemFacts item={item} /><button className="button primary full" disabled={busy} onClick={() => openSearch(item)}><Link2 size={16} />查找对应版本</button>{item.url && <button className="button subtle full" onClick={() => run(() => api.openExternal(item.url!))}>打开平台页面<ArrowUpRight size={15} /></button>}</> : <><div className="detail-illustration"><Disc3 size={60} /><span><Link2 size={18} /></span></div><h3>每个发行版本，都值得保留。</h3><p>选择一项收藏，核对它在其他平台上的对应版本。</p><div className="principle"><ShieldCheck size={18} /><span>同一专辑与完整发行日期优先。精选集、单曲和重制版分别处理。</span></div></>}</aside></div>
    {searching && <Modal title="查找对应版本" close={() => setSearching(undefined)} wide><div className="modal-intro"><Brand platform={searching.platform} small /><strong>{searching.title}</strong><span>→</span><select aria-label="目标平台" value={target} onChange={event => { setTarget(event.target.value as Platform); setResults([]); }}>{platforms.filter(platform => platform !== searching.platform).map(platform => <option key={platform} value={platform}>{labels[platform]}</option>)}</select><button className="button primary compact" disabled={busy} onClick={() => run(() => api.search(searching, target), setResults)}>查找</button></div>
      {target === 'appleMusic' && <div className="hint"><Info size={16} /><span>{view.settings.appleMode === 'native' ? '查找本机 Music.app 资料库。缺少的版本需要先在音乐 App 中加入资料库。' : '查找已在“网页确认”中登记的条目。请先登记并核实目标发行版本。'}</span></div>}
      <div className="candidate-list">{results.length ? results.map(result => <div className="candidate" key={itemKey(result.item)}><div className="candidate-top"><Cover item={result.item} /><div><strong>{result.item.title}</strong><span>{result.item.release?.title ?? result.item.artists.join('、')}</span></div><span className={`assessment ${result.decision}`}>{result.decision === 'compatible' ? '信息一致' : result.decision === 'different' ? '版本不同' : '需要核实'}</span></div><ItemFacts item={result.item} /><p className="candidate-evidence">{result.evidence.join('；')}</p><button className="button secondary compact" disabled={busy || result.decision === 'different'} onClick={() => { setReview({ source: searching, target: result.item }); setSearching(undefined); }}>核实对应关系<ChevronRight size={14} /></button></div>) : <div className="inline-empty"><Search size={24} /><p>选择目标平台，查找相同发行版本。</p></div>}</div>
    </Modal>}
    {review && <MappingModal source={review.source} target={review.target} busy={busy} close={() => setReview(undefined)} save={mapping => run(() => api.addMapping(mapping), value => { setView(value); setReview(undefined); })} />}
  </>;
}
function KindIcon({ kind }: { kind: Kind }) { return kind === 'track' ? <Heart size={15} /> : kind === 'album' ? <Disc3 size={15} /> : <Mic2 size={15} />; }
function MappingModal({ source, target, busy, close, save }: { source: MusicItem; target: MusicItem; busy: boolean; close(): void; save(mapping: Mapping): Promise<void> }) {
  const [sourceDate, setSourceDate] = useState(source.release?.date?.value ?? ''), [targetDate, setTargetDate] = useState(target.release?.date?.value ?? '');
  const [evidence, setEvidence] = useState(''), [confirmed, setConfirmed] = useState(false);
  const datesValid = source.kind === 'artist' || exactDate(sourceDate) && sourceDate === targetDate;
  return <Modal title="核实对应关系" close={close} wide><div className="comparison">{[source, target].map(item => <div key={itemKey(item)}><div className="comparison-platform"><Brand platform={item.platform} small />{labels[item.platform]}</div><h3>{item.title}</h3><ItemFacts item={item} /></div>)}</div>
    {source.kind !== 'artist' && <><div className="hint"><Info size={16} /><span>缺少日期时，请查看发行方或专辑详情后填写，并记录来源。日期必须精确到同一天。</span></div><div className="form-grid"><label>{labels[source.platform]} 发行日期<input placeholder="YYYY-MM-DD" value={sourceDate} disabled={exactDate(source.release?.date?.value)} onChange={event => setSourceDate(event.target.value)} /></label><label>{labels[target.platform]} 发行日期<input placeholder="YYYY-MM-DD" value={targetDate} disabled={exactDate(target.release?.date?.value)} onChange={event => setTargetDate(event.target.value)} /></label></div></>}
    <label className="field">核实依据或来源链接<textarea rows={3} placeholder="记录你核对的专辑版本、完整日期与来源…" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
    <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{source.kind === 'artist' ? '已核实为同一艺人，排除了同名情况' : '已核实为同一发行版本中的同一条目，完整发行日期一致'}</span></label>
    <div className="modal-actions"><button className="button subtle" onClick={close}>取消</button><button className="button primary" disabled={busy || !confirmed || !evidence.trim() || !datesValid} onClick={() => {
      const a = structuredClone(source), b = structuredClone(target);
      if (source.kind !== 'artist' && a.release && b.release) { a.release.date = { value: sourceDate }; b.release.date = { value: targetDate }; }
      void save({ id: crypto.randomUUID(), kind: source.kind, items: [a, b], verified: true, evidence });
    }}><Check size={16} />保存对应关系</button></div>
  </Modal>;
}
function PreviewPage({ view, api, busy, run, update, setView, setNotice }: Props & { setView(view: AppView): void; setNotice(message: string): void }) {
  const [confirm, setConfirm] = useState(false), [pending, setPending] = useState<{ title: string; message: string; url?: string }[]>([]);
  const additions = view.plan?.operations.filter(operation => operation.saved).length ?? 0;
  const removals = view.plan?.operations.filter(operation => !operation.saved).length ?? 0;
  return <><PageHeader eyebrow="REVIEW BEFORE SYNC" title="每一次变更，都清楚可见。" description="确认对应关系后，查看将要添加或取消的收藏。执行前会再次检查状态。" actions={<button className="button secondary" disabled={busy} onClick={() => update(() => api.scan())}><RefreshCw size={16} />重新扫描</button>} />
    {view.demo && <div className="demo-tools"><div><Play size={16} /><span>模拟在 Apple Music 上操作第一首歌曲</span></div><button className="button secondary compact" disabled={busy} onClick={() => update(() => api.simulateDemoChange('appleMusic', false, 'track'))}>模拟取消收藏</button><button className="button subtle compact" disabled={busy} onClick={() => update(() => api.simulateDemoChange('appleMusic', true, 'track'))}>模拟重新收藏</button></div>}
    <div className="summary-grid"><div className="summary-card"><span>添加收藏</span><strong className="green">{additions}<small>项</small></strong></div><div className="summary-card"><span>取消收藏</span><strong className="orange">{removals}<small>项</small></strong></div><div className="summary-card"><span>需要处理</span><strong>{view.plan?.issues.length ?? 0}<small>项</small></strong></div></div>
    <section className="panel"><div className="panel-heading"><div><h2>本次同步计划</h2><p>{view.plan ? '仅包含已确认对应关系且状态可靠的条目' : '请先扫描收藏，生成新的同步预览'}</p></div>{view.plan && <button className="button primary" disabled={busy} onClick={() => setConfirm(true)}><ArrowDownUp size={16} />{view.plan.operations.length ? `执行 ${view.plan.operations.length} 项同步` : '记录本次基线'}</button>}</div>
      {view.plan?.operations.length ? <div className="operation-list">{view.plan.operations.map(operation => <div className="operation" key={operation.id}><span className={operation.saved ? 'operation-icon add' : 'operation-icon remove'}>{operation.saved ? <Plus size={18} /> : <Heart size={18} />}</span><div><strong>{operation.item.title}</strong><span>{operation.item.release?.title ?? operation.item.artists.join('、')} · {operation.reason}</span></div><Brand platform={operation.item.platform} small /><span className={operation.saved ? 'green' : 'orange'}>{operation.saved ? '添加收藏' : '取消收藏'}</span></div>)}</div> : <div className="inline-empty"><CheckCircle2 size={30} /><h3>{view.plan ? '目前没有需要修改的收藏' : '还没有同步预览'}</h3><p>{view.plan ? '记录本次基线，以便下次识别真实变更。' : '扫描只读取数据，不会立即修改收藏。'}</p></div>}
    </section>
    {!!view.plan?.notes?.length && <section className="panel"><div className="panel-heading"><h2>扫描说明</h2></div>{view.plan.notes.map(note => <p className="panel-note" key={note}>{note}</p>)}</section>}
    {!!view.spotifyScanIssues.length && <section className="panel spotify-diagnostics" aria-label="Spotify 异常条目">
      <div className="panel-heading"><div><h2>Spotify 异常条目（{view.spotifyScanIssues.length}）</h2><p>逐项检查缺失信息，收藏状态保持未知</p></div><div className="heading-actions">
        <button className="button secondary compact" disabled={busy} onClick={() => update(() => api.inspectSpotifyIssues())}>检查异常条目详情</button>
        <button className="button subtle compact" disabled={busy} onClick={() => run(() => api.exportSpotifyDiagnostics(), saved => { if (saved) setNotice('Spotify 诊断已导出，不包含登录凭据。'); })}><Download size={14} />导出 Spotify 诊断</button>
      </div></div>
      <p className="panel-note">详情检查只读取 Spotify，不修改收藏。导出文件包含下列异常条目的音乐信息与检查结果，不包含 Token、Cookie 或账户资料。</p>
      {view.spotifyScanIssues.map(issue => <div className="spotify-diagnostic-row" key={`${issue.kind}:${issue.position}`}>
        <strong>{issue.source.name ?? '名称未返回'}</strong><small>{kindLabels[issue.kind]} · 第 {issue.position} 项 · ID：{issue.source.id ?? '未返回有效 ID'}</small>
        {!!issue.source.artists.length && <p>艺人：{issue.source.artists.join('、')}</p>}
        {issue.source.album?.name && <p>所属发行：{issue.source.album.name} · {issue.source.album.releaseDate ?? '未返回日期'}</p>}
        <p>{issue.problem}</p>
        {issue.inspection && <p className="diagnostic-finding">{issue.inspection.explanation}{issue.inspection.detail?.name ? ` 详情返回名称：${issue.inspection.detail.name}` : ''}</p>}
        <details><summary>查看诊断字段</summary><pre>{JSON.stringify({ collection: issue.source, detail: issue.inspection }, null, 2)}</pre></details>
        {issue.url && <button className="button subtle compact" disabled={busy} onClick={() => run(() => api.openExternal(issue.url!))}>打开 Spotify 页面<ArrowUpRight size={14} /></button>}
      </div>)}
    </section>}
    {!!view.plan?.issues.length && <section className="panel issues"><h2><AlertCircle size={18} />待处理项目</h2>{view.plan.issues.map(issue => <p key={issue.id}>{issue.message}</p>)}</section>}
    {!!pending.length && <section className="panel issues"><h2>尚未完成的操作</h2>{pending.map((item, index) => <div key={index}><strong>{item.title}</strong><p>{item.message}</p>{item.url && <button className="button secondary compact" onClick={() => run(() => api.openExternal(item.url!))}>打开平台页面<ArrowUpRight size={14} /></button>}</div>)}</section>}
    {confirm && <Modal title="执行本次同步？" close={() => setConfirm(false)}><div className="hint"><ShieldCheck size={20} /><span>{view.demo ? '当前为离线演示，操作只影响示例数据。' : `将添加 ${additions} 项、取消 ${removals} 项收藏。取消会传播到对应平台；未知或不支持的状态保留待处理。`}</span></div><div className="modal-actions"><button className="button subtle" onClick={() => setConfirm(false)}>返回检查</button><button className="button primary" disabled={busy} onClick={() => { const id = view.plan?.id; setConfirm(false); if (id) void run(() => api.apply(id), result => { setView(result.view); setPending(result.report.pending); }); }}>确认执行</button></div></Modal>}
  </>;
}
function MappingsPage({ view, api, busy, update }: Omit<Props, 'run'>) {
  return <><PageHeader eyebrow="THE SAME RELEASE" title="把对应关系，认真确认一次。" description="同一曲目的不同发行分别保留；确认后的对应关系会在之后的同步中复用。" />
    <section className="panel"><div className="panel-heading"><h2>已确认对应关系 <span className="count">{view.state.mappings.length}</span></h2></div>
      {view.state.mappings.length ? view.state.mappings.map(mapping => <div className="mapping-row" key={mapping.id}><div className="mapping-title"><Link2 size={19} /><div><strong>{mappingTitle(mapping)}</strong><p>{mapping.items[0]?.release?.title ?? kindLabels[mapping.kind]} · {mapping.items[0]?.release?.date?.value ?? '艺人身份已确认'}</p></div></div><div className="mapping-platforms">{mapping.items.map(item => <Brand key={itemKey(item)} platform={item.platform} small />)}</div><details><summary>核实依据</summary><p>{mapping.evidence}</p></details><button className="button subtle compact" disabled={busy} onClick={() => update(() => api.removeMapping(mapping.id))}>移除对应关系</button></div>) : <div className="inline-empty"><Link2 size={30} /><h3>还没有对应关系</h3><p>从音乐收藏中选择条目，查找并核实另一平台的版本。</p></div>}
    </section><section className="panel"><div className="panel-heading"><h2>最近操作</h2></div>{view.state.audit.length ? [...view.state.audit].reverse().slice(0, 30).map(entry => <div className="audit-row" key={entry.id}><span className="audit-dot" /><span>{entry.message}</span><time>{new Date(entry.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>) : <p className="panel-note">执行同步或确认对应关系后，操作会记录在这里。</p>}</section>
  </>;
}
function ApplePage({ view, api, busy, update, run, setPage }: Props & { setPage(page: Page): void }) {
  const [adding, setAdding] = useState(false), [confirm, setConfirm] = useState<{ item: MusicItem; saved: boolean }>();
  return <><PageHeader eyebrow="APPLE MUSIC · WEB REVIEW" title="在网页操作，在这里确认。" description="使用你自己的浏览器和 Apple Music 账户，无需付费开发者会员。" actions={<button className="button primary" disabled={busy || view.demo} onClick={() => setAdding(true)}><Plus size={16} />登记网页条目</button>} />
    <div className="hint large"><Globe size={23} /><div><strong>网页确认模式适用于 Mac、Windows 和 Linux。</strong><p>本页只记录你手动核实的收藏状态，不会自动读取网页。打开条目、完成添加或取消后，返回确认实际状态，再扫描同步。</p></div></div>
    {view.settings.appleMode !== 'web' && <div className="alert"><Info size={18} /><span>当前未启用网页确认模式。切换接入方式后，需重新核实对应关系与基线。</span><button className="button secondary compact" onClick={() => setPage('settings')}>前往设置</button></div>}
    <section className="panel"><div className="panel-heading"><h2>已核实的网页条目</h2><span className="muted">{view.manualApple.length} 项</span></div>{view.manualApple.length ? view.manualApple.map(record => <div className="manual-row" key={itemKey(record.item)}><Brand platform="appleMusic" /><div><strong>{record.item.title}</strong><p>{record.item.release?.title ?? record.item.artists.join('、')} · {record.saved ? '已确认收藏' : '已确认取消'}</p><small>核实于 {new Date(record.checkedAt).toLocaleString('zh-CN')}</small></div><button className="button subtle compact" onClick={() => run(() => api.openExternal(record.item.url!))}>打开网页<ArrowUpRight size={14} /></button><button className="button secondary compact" disabled={busy || view.demo} onClick={() => setConfirm({ item: record.item, saved: !record.saved })}>{record.saved ? '确认已取消' : '确认已收藏'}</button></div>) : <div className="inline-empty"><Globe size={30} /><h3>登记你核实过的歌曲、专辑或艺人</h3><p>填写 Apple Music 页面链接、所属发行版本和完整日期。</p></div>}</section>
    {adding && <AppleEntryModal busy={busy} close={() => setAdding(false)} save={(item, saved) => update(async () => { const view = await api.recordApple(item, saved); setAdding(false); return view; })} />}
    {confirm && <Modal title="确认 Apple Music 的实际状态" close={() => setConfirm(undefined)}><h3>{confirm.item.title}</h3><p className="modal-description">请先在 Apple Music 网页完成操作。此确认将被视为你主动{confirm.saved ? '添加' : '取消'}收藏，可传播到其他平台。</p><button className="button secondary" onClick={() => run(() => api.openExternal(confirm.item.url!))}>打开条目网页<ArrowUpRight size={15} /></button><div className="modal-actions"><button className="button subtle" onClick={() => setConfirm(undefined)}>返回</button><button className="button primary" disabled={busy} onClick={() => { const item = confirm; setConfirm(undefined); void update(() => api.recordApple(item.item, item.saved)); }}>我已核实：{confirm.saved ? '已收藏' : '已取消收藏'}</button></div></Modal>}
  </>;
}
function AppleEntryModal({ busy, close, save }: { busy: boolean; close(): void; save(item: MusicItem, saved: boolean): Promise<void> }) {
  const [kind, setKind] = useState<Kind>('track'), [url, setURL] = useState(''), [title, setTitle] = useState(''), [artist, setArtist] = useState('');
  const [album, setAlbum] = useState(''), [date, setDate] = useState(''), [saved, setSaved] = useState(true), [checked, setChecked] = useState(false), [error, setError] = useState('');
  function submit() {
    try {
      const parsed = new URL(url), id = kind === 'track' && parsed.searchParams.has('i') ? parsed.searchParams.get('i')! : parsed.pathname.split('/').filter(Boolean).at(-1)!;
      if (!/^\d+$/u.test(id) || parsed.protocol !== 'https:' || parsed.hostname !== 'music.apple.com') throw new Error('请提供正确的 Apple Music 页面链接');
      const item: MusicItem = { platform: 'appleMusic', kind, id: `web-${kind}:${id}`, title, artists: [artist], url,
        ...(kind === 'artist' ? {} : { release: { title: kind === 'album' ? title : album, artists: [artist], ...(date ? { date: { value: date } } : {}) } }) };
      void save(item, saved);
    } catch (error) { setError(error instanceof Error ? error.message : '链接无效'); }
  }
  return <Modal title="登记 Apple Music 网页条目" close={close}><div className="form-grid"><label>收藏类型<select value={kind} onChange={event => setKind(event.target.value as Kind)}>{kinds.map(kind => <option key={kind} value={kind}>{kindLabels[kind]}</option>)}</select></label><label>已核实状态<select value={String(saved)} onChange={event => setSaved(event.target.value === 'true')}><option value="true">已收藏</option><option value="false">未收藏 / 已取消</option></select></label></div>
    <label className="field">Apple Music 页面链接<input placeholder="https://music.apple.com/…" value={url} onChange={event => setURL(event.target.value)} /></label><label className="field">{kind === 'track' ? '歌名' : kind === 'album' ? '专辑名' : '艺人名'}<input value={title} onChange={event => setTitle(event.target.value)} /></label><label className="field">{kind === 'artist' ? '艺人名' : '艺人 / 专辑艺人'}<input value={artist} onChange={event => setArtist(event.target.value)} /></label>
    {kind !== 'artist' && <div className="form-grid">{kind === 'track' && <label>所属专辑 / 单曲发行<input value={album} onChange={event => setAlbum(event.target.value)} /></label>}<label>完整发行日期<input placeholder="YYYY-MM-DD" value={date} onChange={event => setDate(event.target.value)} /></label></div>}
    <label className="checkbox"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /><span>我已打开该页面并核实条目身份与当前收藏状态</span></label>{error && <p className="orange">{error}</p>}<div className="modal-actions"><button className="button subtle" onClick={close}>取消</button><button className="button primary" disabled={busy || !checked || !title.trim() || !artist.trim() || !url || kind !== 'artist' && (!exactDate(date) || kind === 'track' && !album.trim())} onClick={submit}>保存核实记录</button></div>
  </Modal>;
}
function SettingsPage({ view, api, busy, run, update, setView, setNotice, error }: Props & { setView(view: AppView): void; setNotice(message: string): void; error: string }) {
  const [clientID, setClientID] = useState(view.settings.spotifyClientID), [appleMode, setAppleMode] = useState(view.settings.appleMode);
  const [qr, setQR] = useState<{ key: string; image: string }>();
  const [qrStatus, setQRStatus] = useState('扫码后在手机上确认，再检查登录状态。');
  const settings = () => ({ spotifyClientID: clientID.trim(), appleMode });
  const connected = (platform: Platform): boolean => view.connections.find(connection => connection.platform === platform)?.connected ?? false;
  return <><PageHeader eyebrow="CONNECTED ACCOUNTS" title="让你的音乐平台连接起来。" description="账户凭据留在本机，收藏对应关系可以单独导出备份。" />
    {view.credentialStorage === 'session' && <div className="hint"><ShieldCheck size={20} /><span>当前系统安全存储不可用，登录凭据仅在本次运行中保留，关闭应用后需要重新登录。</span></div>}
    <div className="settings-stack"><section className="panel setting-card"><div className="setting-title"><Brand platform="spotify" /><div><h2>Spotify</h2><p>主要收藏平台 · 官方接口</p></div><span className="connection-tag online">{connected('spotify') ? '已连接' : '等待连接'}</span></div><label className="field">Client ID<input placeholder="粘贴你的 Spotify 应用 Client ID" value={clientID} onChange={event => setClientID(event.target.value)} disabled={busy} /></label><div className="hint"><Info size={16} /><span>在 Spotify Developer Dashboard 创建个人应用，并将回调地址设为 <code>http://127.0.0.1:19428/callback</code>。无需填写 Client Secret。</span></div><div className="setting-actions"><button className="button primary" disabled={busy || view.demo} onClick={() => run(async () => { await api.saveSettings(settings()); return api.connectSpotify(); }, setView)}>{connected('spotify') ? '重新授权' : '连接 Spotify'}<ArrowUpRight size={15} /></button><button className="button subtle" onClick={() => run(() => api.openExternal('https://developer.spotify.com/dashboard'))}>打开 Dashboard<ArrowUpRight size={14} /></button>{connected('spotify') && <button className="button subtle" disabled={busy || view.demo} onClick={() => update(() => api.disconnect('spotify'))}>断开连接</button>}{busy && <button className="button subtle" onClick={() => void api.cancelLogin()}>取消授权等待</button>}</div></section>
    <section className="panel setting-card"><div className="setting-title"><Brand platform="appleMusic" /><div><h2>Apple Music</h2><p>无需付费开发者会员</p></div></div><label className="field">接入方式<select value={appleMode} disabled={busy} onChange={event => setAppleMode(event.target.value as AppView['settings']['appleMode'])}><option value="web">网页确认 · 所有系统可用</option>{view.os === 'darwin' && <option value="native">本机 Music.app · macOS</option>}<option value="disabled">暂不启用</option></select></label><div className="hint"><Info size={18} /><span>{appleMode === 'native' ? '读取和修改 Music.app 资料库内歌曲、专辑的喜爱星标。请先打开音乐 App 并完成资料库同步；首次扫描时允许自动化权限。完整艺人列表和资料库外曲目仍需人工处理。' : '通过系统浏览器完成收藏操作，再在“网页确认”页登记实际状态。此方式不会自动读取 Apple Music 网页。'}</span></div><p className="setting-note">切换接入方式或更换 Apple 账户后，应导出备份并重新建立对应关系与基线。</p><button className="button secondary" disabled={busy} onClick={() => update(() => api.saveSettings(settings()))}>保存接入方式</button></section>
    <section className="panel setting-card"><div className="setting-title"><Brand platform="netease" /><div><h2>网易云音乐</h2><p>扫码连接 · 社区接口</p></div><span className="connection-tag online">{connected('netease') ? '已连接' : '等待连接'}</span></div><p className="setting-note">使用网易云音乐手机 App 扫码并确认。扫码受网易云风控影响，若提示“设备环境异常”，请暂停扫码并按手机页面提示处理。</p><div className="setting-actions"><button className="button secondary" disabled={busy || view.demo} onClick={() => run(() => api.startNeteaseLogin(), result => { setQRStatus('扫码后在手机上确认，再检查登录状态。'); setQR(result); })}>{connected('netease') ? '重新扫码登录' : '生成登录二维码'}</button>{connected('netease') && <button className="button subtle" disabled={busy || view.demo} onClick={() => update(() => api.disconnect('netease'))}>断开连接</button>}</div></section>
    <section className="panel setting-card"><div className="setting-title"><div className="setting-symbol"><ShieldCheck size={23} /></div><div><h2>本地数据</h2><p>跨设备使用前，请重新连接各平台账户</p></div></div><div className="setting-actions"><button className="button secondary" disabled={busy} onClick={() => run(() => api.exportBackup(), saved => { if (saved) setNotice('已导出备份，不包含账户凭据。'); })}><Download size={15} />导出备份</button><button className="button secondary" disabled={busy} onClick={() => update(() => api.importBackup())}><Upload size={15} />导入备份</button><button className="button subtle danger-text" disabled={busy} onClick={() => update(() => api.resetHistory())}>重新建立基线</button></div></section></div>
    {qr && <Modal title="使用网易云音乐 App 扫码" close={() => setQR(undefined)}>
      <div className="qr-panel"><img src={qr.image} width="210" height="210" alt="网易云登录二维码" /><p role="status" aria-live="polite">{qrStatus}</p></div>
      {error && <div className="alert error" role="alert"><AlertCircle size={18} /><span>{error}</span></div>}
      <div className="hint"><Info size={16} /><span>手机若提示“设备环境异常”，请先关闭二维码，检查官方 App 和日常网络，并按手机页面提示稍后再试。</span></div>
      <div className="modal-actions"><button className="button subtle" onClick={() => setQR(undefined)}>关闭</button><button className="button primary" disabled={busy} onClick={() => run(() => api.checkNeteaseLogin(qr.key), result => {
        setView(result.view);
        if (result.code === 803) { setQR(undefined); return; }
        const message = result.code === 800 ? '二维码已过期，请重新生成。' : result.code === 802 ? '请在手机上确认登录。' : '等待扫码。';
        if (result.code === 800) setQR(undefined);
        setQRStatus(message); setNotice(message);
      })}>检查登录状态</button></div>
    </Modal>}
  </>;
}
