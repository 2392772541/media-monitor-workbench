import { useEffect, useMemo, useState } from 'react';
import {
  Flame,
  RefreshCw,
  ArrowRight,
  Star,
  Sparkles,
  Globe,
  Newspaper,
  Plus,
  Settings2,
  Trash2,
  ExternalLink,
  Wand2,
  Send,
} from 'lucide-react';
import { apiRequest, fmtNum, fmtTime, PLATFORM_LABELS } from '../api';
import type { DrawerTab } from '../components/ContentDrawer';
import type {
  CockpitData,
  CreatorLeaderboardItem,
  NewsBriefItem,
  NewsBriefSnapshot,
  PublishInspirationDraft,
} from '../types';

interface CockpitPageProps {
  refreshTick: number;
  onNavigate: (tab: string) => void;
  onOpenContent: (contentId: number, tab?: DrawerTab, savedBoardId?: number | null) => void;
  onOpenRemix: (contentId: number) => void;
  onSendToPublish: (draft: PublishInspirationDraft) => void;
  onRefreshBadge: () => void;
  onToast: (msg: string) => void;
}

export function CockpitPage({
  refreshTick,
  onNavigate,
  onOpenContent,
  onOpenRemix,
  onSendToPublish,
  onRefreshBadge,
  onToast,
}: CockpitPageProps) {
  const [news, setNews] = useState<NewsBriefSnapshot | null>(null);
  const [topBreakouts, setTopBreakouts] = useState<CreatorLeaderboardItem[]>([]);
  const [stats, setStats] = useState<CockpitData['stats'] | null>(null);

  const [loading, setLoading] = useState(true);
  const [refreshingNews, setRefreshingNews] = useState(false);
  const [generatingDigest, setGeneratingDigest] = useState(false);

  // 过滤与自定义控制
  const [focusOnly, setFocusOnly] = useState(false);
  const [domesticSourceFilter, setDomesticSourceFilter] = useState('all');
  const [globalSourceFilter, setGlobalSourceFilter] = useState('all');
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [newSourceRegion, setNewSourceRegion] = useState<'domestic' | 'global'>('domestic');
  const [addingSource, setAddingSource] = useState(false);

  const loadAll = async (autoRefreshIfEmpty = false) => {
    try {
      const [newsRes, lbRes, cockpitRes] = await Promise.all([
        apiRequest<NewsBriefSnapshot>('/api/radar/news-brief'),
        apiRequest<{ items: CreatorLeaderboardItem[] }>('/api/radar/creators/leaderboard?sort=ratio&limit=4'),
        apiRequest<CockpitData>('/api/radar/cockpit'),
      ]);
      setNews(newsRes);
      setTopBreakouts(lbRes.items || []);
      setStats(cockpitRes.stats);

      // 首次打开如果早报缓存为空，自动静默拉取一轮国内外一手 AI 新闻
      if (autoRefreshIfEmpty && newsRes.items.length === 0) {
        setRefreshingNews(true);
        try {
          const fresh = await apiRequest<NewsBriefSnapshot>('/api/radar/news-brief/refresh', { method: 'POST' });
          setNews(fresh);
        } finally {
          setRefreshingNews(false);
        }
      }
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll(true);
  }, [refreshTick]);

  const handleRefreshNews = async () => {
    setRefreshingNews(true);
    try {
      const fresh = await apiRequest<NewsBriefSnapshot>('/api/radar/news-brief/refresh', { method: 'POST' });
      setNews(fresh);
      const okCount = fresh.sourceStats.filter((s) => s.count > 0).length;
      onToast(`已更新国内外最新热点：共 ${fresh.items.length} 条（${okCount} 个一手源正常返回）`);
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setRefreshingNews(false);
    }
  };

  const handleGenerateDigest = async (forceRefresh = false) => {
    setGeneratingDigest(true);
    try {
      const res = await apiRequest<{ ok: boolean; translatedCount: number; cached?: boolean }>(
        '/api/radar/news-brief/digest',
        {
          method: 'POST',
          body: JSON.stringify({ forceRefresh }),
        }
      );
      await loadAll(false);
      onToast(
        res.cached
          ? '已载入今日 1 分钟国内外早报摘要'
          : `今日早报已生成，并自动翻译了 ${res.translatedCount} 条海外新闻标题！`
      );
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setGeneratingDigest(false);
    }
  };

  const handleAddFocusKeyword = async () => {
    const kw = newKeyword.trim();
    if (!kw || !news) return;
    const next = Array.from(new Set([...news.focusKeywords, kw]));
    await apiRequest('/api/radar/preferences/keywords', {
      method: 'PUT',
      body: JSON.stringify({ focusKeywords: next }),
    });
    setNewKeyword('');
    await loadAll(false);
    onToast(`已添加关注词「${kw}」（今日速览与平台热榜同步生效）`);
  };

  const handleRemoveFocusKeyword = async (kw: string) => {
    if (!news) return;
    const next = news.focusKeywords.filter((x) => x !== kw);
    await apiRequest('/api/radar/preferences/keywords', {
      method: 'PUT',
      body: JSON.stringify({ focusKeywords: next }),
    });
    await loadAll(false);
  };

  const handleToggleNewsSource = async (id: string, enabled: boolean) => {
    try {
      await apiRequest('/api/radar/news-brief/sources/toggle', {
        method: 'POST',
        body: JSON.stringify({ id, enabled }),
      });
      await loadAll(false);
      onToast(enabled ? '已开启该新闻源，点「刷新国内外热点」立即拉取' : '已关闭该新闻源');
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const handleAddCustomSource = async () => {
    if (!newSourceUrl.trim()) {
      onToast('请粘贴新闻源或网站的 RSS 链接');
      return;
    }
    setAddingSource(true);
    try {
      await apiRequest('/api/radar/news-brief/sources', {
        method: 'POST',
        body: JSON.stringify({
          name: newSourceName.trim() || undefined,
          url: newSourceUrl.trim(),
          region: newSourceRegion,
        }),
      });
      setNewSourceName('');
      setNewSourceUrl('');
      onToast('已添加自定义新闻源，正在刷新热点...');
      await handleRefreshNews();
    } catch (err) {
      onToast((err as Error).message);
    } finally {
      setAddingSource(false);
    }
  };

  const handleDeleteCustomSource = async (id: string) => {
    await apiRequest(`/api/radar/news-brief/sources/${id}`, { method: 'DELETE' });
    await loadAll(false);
    onToast('已移除该自定义新闻源');
  };

  const handleSaveNewsToBoard = async (title: string, summary: string, url: string, sourceName: string) => {
    try {
      await apiRequest('/api/radar/board', {
        method: 'POST',
        body: JSON.stringify({
          title,
          core_angle: summary,
          tags: ['行业早报', sourceName],
          source_url: url,
        }),
      });
      onToast('已收藏到「简易收藏本」');
      onRefreshBadge();
    } catch (err) {
      onToast((err as Error).message);
    }
  };

  const blockedSet = useMemo(() => (news?.blockKeywords || []).map((k) => k.toLowerCase()), [news?.blockKeywords]);

  const filteredNewsItems = useMemo(() => {
    const all = news?.items || [];
    return all.filter((it) => {
      const hay = `${it.title} ${it.titleZh || ''} ${it.summary}`.toLowerCase();
      if (blockedSet.some((b) => b && hay.includes(b))) return false;
      if (focusOnly && (news?.focusKeywords?.length || 0) > 0) {
        return it.matchedKeywords.length > 0;
      }
      return true;
    });
  }, [news?.items, news?.focusKeywords, blockedSet, focusOnly]);

  const domesticAll = useMemo(() => filteredNewsItems.filter((x) => x.region === 'domestic'), [filteredNewsItems]);
  const globalAll = useMemo(() => filteredNewsItems.filter((x) => x.region === 'global'), [filteredNewsItems]);

  const domesticSources = useMemo(() => Array.from(new Set(domesticAll.map((x) => x.sourceName))), [domesticAll]);
  const globalSources = useMemo(() => Array.from(new Set(globalAll.map((x) => x.sourceName))), [globalAll]);

  const domesticShown = useMemo(
    () => (domesticSourceFilter === 'all' ? domesticAll : domesticAll.filter((x) => x.sourceName === domesticSourceFilter)).slice(0, 14),
    [domesticAll, domesticSourceFilter]
  );
  const globalShown = useMemo(
    () => (globalSourceFilter === 'all' ? globalAll : globalAll.filter((x) => x.sourceName === globalSourceFilter)).slice(0, 14),
    [globalAll, globalSourceFilter]
  );

  const todayStr = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

  const renderNewsRow = (item: NewsBriefItem) => (
    <div key={item.id} className="news-item-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <a href={item.url} target="_blank" rel="noreferrer" className="news-item-title">
            {item.titleZh || item.title}
          </a>
          {item.titleZh && item.titleZh !== item.title && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{item.title}</div>
          )}
          {(item.summaryZh || item.summary) && (
            <div style={{ fontSize: 12.5, color: '#475569', marginTop: 4, lineHeight: 1.5 }}>
              {(item.summaryZh || item.summary).slice(0, 110)}
              {(item.summaryZh || item.summary).length > 110 ? '...' : ''}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span className="badge badge-gray" style={{ fontSize: 11 }}>{item.sourceName}</span>
            {item.heatLabel && <span className="badge badge-amber" style={{ fontSize: 11 }}>{item.heatLabel}</span>}
            {item.matchedKeywords.slice(0, 3).map((kw) => (
              <span key={kw} className="badge badge-blue" style={{ fontSize: 11 }}>
                命中 {kw}
              </span>
            ))}
            {item.publishedAt && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtTime(item.publishedAt)}</span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            className="btn btn-sm"
            style={{ padding: '4px 8px' }}
            title="收藏到本子"
            onClick={() =>
              void handleSaveNewsToBoard(
                item.titleZh || item.title,
                item.summaryZh || item.summary,
                item.url,
                item.sourceName
              )
            }
          >
            <Star size={12} />
          </button>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="btn btn-sm"
            style={{ padding: '4px 8px', textDecoration: 'none' }}
            title="打开原文"
          >
            <ExternalLink size={12} />
          </a>
        </div>
      </div>
    </div>
  );

  if (loading && !news) {
    return (
      <div className="panel-card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
        正在拉取国内外最新 AI 与科技一手热点...
      </div>
    );
  }

  const matchedCount = (news?.items || []).filter((x) => x.matchedKeywords.length > 0).length;

  return (
    <div>
      {/* 顶部清爽主控栏 */}
      <div className="compact-status-bar">
        <div className="status-chips">
          <span className="status-chip">
            📅 <strong>{todayStr}</strong>
          </span>
          <span className="status-chip">
            🇨🇳 国内一手 <strong>{domesticAll.length}</strong>
          </span>
          <span className="status-chip">
            🌍 海外一手 <strong>{globalAll.length}</strong>
          </span>
          <span className="status-chip hot" onClick={() => onNavigate('creators')}>
            🔥 对标爆款 <strong>{stats?.breakoutCount ?? topBreakouts.length}</strong>
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`btn btn-sm ${showConfigPanel ? 'btn-primary' : ''}`}
            onClick={() => setShowConfigPanel((v) => !v)}
          >
            <Settings2 size={13} /> 管理关注词与新闻源
          </button>
          <button
            type="button"
            data-testid="brief-refresh-btn"
            className="btn btn-sm"
            disabled={refreshingNews}
            onClick={() => void handleRefreshNews()}
          >
            <RefreshCw size={13} /> {refreshingNews ? '拉取中...' : '刷新国内外热点'}
          </button>
          <button
            type="button"
            data-testid="brief-ai-digest-btn"
            className="btn btn-primary btn-sm"
            disabled={generatingDigest}
            onClick={() => void handleGenerateDigest(Boolean(news?.digest))}
          >
            <Sparkles size={13} /> {generatingDigest ? 'AI 提炼与翻译中...' : news?.digest ? '更新今日早报与翻译' : 'AI 生成今日早报 & 翻译海外'}
          </button>
        </div>
      </div>

      {/* 自定义关注词快筛条（与「平台热榜」共用一套自定义词，随时增删） */}
      <div className="panel-card" style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="kw-strip" style={{ flex: '1 1 420px' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>我的关注词：</span>
            {(news?.focusKeywords || []).map((kw) => (
              <span key={kw} className="kw-chip">
                {kw}
                <button type="button" title="移除" onClick={() => void handleRemoveFocusKeyword(kw)}>
                  ×
                </button>
              </span>
            ))}
            <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input
                className="input"
                style={{ width: 126, padding: '4px 8px', fontSize: 12 }}
                placeholder="+ 加一个关注词"
                value={newKeyword}
                onChange={(e) => setNewKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleAddFocusKeyword()}
              />
              {newKeyword.trim() && (
                <button type="button" className="btn btn-primary btn-sm" style={{ padding: '4px 9px' }} onClick={() => void handleAddFocusKeyword()}>
                  加词
                </button>
              )}
            </div>
          </div>

          <div className="pill-group">
            <button
              type="button"
              className={`pill-btn ${!focusOnly ? 'active' : ''}`}
              onClick={() => setFocusOnly(false)}
            >
              全部最新 ({news?.items.length || 0})
            </button>
            <button
              type="button"
              className={`pill-btn ${focusOnly ? 'active' : ''}`}
              onClick={() => setFocusOnly(true)}
            >
              只看命中关注词 ({matchedCount})
            </button>
          </div>
        </div>

        {/* 可展开：勾选内置国内外源 + 自由添加任意自定义新闻/RSS 源 */}
        {showConfigPanel && news && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'grid', gap: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>勾选想盯的国内外新闻源（随时开关，或粘贴任意网站 RSS 新增）</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
              {news.newsSources.map((src) => (
                <div
                  key={src.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    padding: '7px 10px',
                    borderRadius: 9,
                    background: 'var(--surface-muted)',
                  }}
                >
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer', minWidth: 0 }}>
                    <input
                      type="checkbox"
                      checked={src.enabled}
                      onChange={(e) => void handleToggleNewsSource(src.id, e.target.checked)}
                    />
                    <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {src.region === 'domestic' ? '🇨🇳' : '🌍'} {src.name}
                    </span>
                  </label>
                  {!src.builtin && (
                    <button
                      type="button"
                      className="icon-ghost-btn"
                      title="删除自定义源"
                      onClick={() => void handleDeleteCustomSource(src.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="input"
                style={{ flex: '1 1 140px', maxWidth: 180 }}
                placeholder="新闻源名称（如 极客公园）"
                value={newSourceName}
                onChange={(e) => setNewSourceName(e.target.value)}
              />
              <input
                className="input"
                style={{ flex: '2 1 260px' }}
                placeholder="粘贴任意网站 RSS / Atom 订阅链接（https://...）"
                value={newSourceUrl}
                onChange={(e) => setNewSourceUrl(e.target.value)}
              />
              <select
                className="select"
                style={{ width: 108 }}
                value={newSourceRegion}
                onChange={(e) => setNewSourceRegion(e.target.value as 'domestic' | 'global')}
              >
                <option value="domestic">国内源</option>
                <option value="global">海外源</option>
              </select>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={addingSource}
                onClick={() => void handleAddCustomSource()}
              >
                <Plus size={13} /> {addingSource ? '添加中...' : '添加新闻源'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 第一层：✨ AI 今日 1 分钟国内外早报摘要（直接给“发生了啥 + 可以怎么拍”） */}
      <section className="news-digest-hero">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="badge badge-blue">
                <Sparkles size={12} style={{ marginRight: 4 }} /> AI 今日 1 分钟热点早报
              </span>
              {news?.digest?.generatedAt && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  更新于 {fmtTime(news.digest.generatedAt)}
                </span>
              )}
            </div>
            <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', marginTop: 6 }}>
              {news?.digest?.headline || '点右上角「AI 生成今日早报 & 翻译海外」，10 秒浓缩今日国内外最值得拍的大事'}
            </div>
          </div>
          {!news?.digest && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={generatingDigest}
              onClick={() => void handleGenerateDigest(false)}
            >
              <Sparkles size={13} /> {generatingDigest ? '生成中...' : '立即生成早报'}
            </button>
          )}
        </div>

        {news?.digest && news.digest.topStories.length > 0 && (
          <div className="news-story-grid">
            {news.digest.topStories.map((st, idx) => (
              <div key={idx} className="news-story-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <span className={`badge ${st.region === 'global' ? 'badge-blue' : 'badge-amber'}`}>
                    {st.region === 'global' ? '🌍 海外一手' : '🇨🇳 国内热点'} · {st.sourceName}
                  </span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>#{idx + 1}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', lineHeight: 1.4 }}>
                  {st.titleZh}
                </div>
                <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.5 }}>{st.whyItMatters}</div>
                {st.videoAngle && (
                  <div style={{ fontSize: 12, color: '#166534', background: '#f0fdf4', padding: '6px 9px', borderRadius: 8 }}>
                    <strong>可拍角度：</strong>{st.videoAngle}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 'auto', paddingTop: 4 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void handleSaveNewsToBoard(st.titleZh, `${st.whyItMatters}\n可拍角度：${st.videoAngle}`, st.url, st.sourceName)}
                  >
                    <Star size={12} /> 存选题
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      onSendToPublish({
                        title: st.titleZh,
                        tags: ['AI热点', st.sourceName],
                        script: `${st.titleZh}\n\n核心事实：${st.whyItMatters}\n\n我的切入角度：${st.videoAngle}`,
                        sourceName: st.sourceName,
                        sourceUrl: st.url,
                      })
                    }
                  >
                    <Send size={12} /> 写发布文案
                  </button>
                  {st.url && (
                    <a href={st.url} target="_blank" rel="noreferrer" className="btn btn-sm" style={{ textDecoration: 'none' }}>
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 第二层：左右双栏实时新闻流（左：国内 AI 科技一手 | 右：海外 AI 科技一手） */}
      <section className="news-dual-grid">
        {/* 左栏：国内一手 */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <Newspaper size={16} color="#ea580c" />
              <span>国内 AI 与科技热点 ({domesticAll.length})</span>
            </div>
            <div className="pill-group">
              <button
                type="button"
                className={`pill-btn ${domesticSourceFilter === 'all' ? 'active' : ''}`}
                onClick={() => setDomesticSourceFilter('all')}
              >
                全部
              </button>
              {domesticSources.slice(0, 5).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`pill-btn ${domesticSourceFilter === name ? 'active' : ''}`}
                  onClick={() => setDomesticSourceFilter(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {domesticShown.length === 0 ? (
            <div style={{ padding: '28px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              {focusOnly ? '当前没有命中关注词的国内快讯，可切回「全部最新」或放宽关注词。' : '暂无国内热点，点击右上角「刷新国内外热点」。'}
            </div>
          ) : (
            <div>{domesticShown.map(renderNewsRow)}</div>
          )}
        </div>

        {/* 右栏：海外一手 */}
        <div className="panel-card" style={{ marginBottom: 0 }}>
          <div className="panel-head">
            <div className="panel-title">
              <Globe size={16} color="#4f46e5" />
              <span>海外 AI 与开源一手 ({globalAll.length})</span>
            </div>
            <div className="pill-group">
              <button
                type="button"
                className={`pill-btn ${globalSourceFilter === 'all' ? 'active' : ''}`}
                onClick={() => setGlobalSourceFilter('all')}
              >
                全部
              </button>
              {globalSources.slice(0, 5).map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`pill-btn ${globalSourceFilter === name ? 'active' : ''}`}
                  onClick={() => setGlobalSourceFilter(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {globalShown.length === 0 ? (
            <div style={{ padding: '28px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              {focusOnly ? '当前没有命中关注词的海外快讯，可切回「全部最新」查看。' : '暂无海外一手动态，点击右上角「刷新国内外热点」。'}
            </div>
          ) : (
            <div>{globalShown.map(renderNewsRow)}</div>
          )}
        </div>
      </section>

      {/* 第三层：对标博主 · 今日爆款排行榜 Top 4（直通爆款二创工坊） */}
      <section className="panel-card" style={{ marginBottom: 0 }}>
        <div className="panel-head">
          <div className="panel-title">
            <Flame size={17} color="#ea580c" />
            <span>对标博主 · 爆款排行榜 Top {topBreakouts.length}</span>
            <span className="badge badge-amber">直接点「拆解与二创」写你的新口播稿</span>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate('creators')}>
            进入完整爆款排行榜 <ArrowRight size={13} />
          </button>
        </div>

        {topBreakouts.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            还没有对标博主数据，去「对标博主」添加同行主页即可自动生成爆款排名。
          </div>
        ) : (
          <div className="rank-card-list">
            {topBreakouts.map((item) => (
              <div key={item.id} className="rank-card">
                <span className={`rank-medal ${item.rank === 1 ? 'top1' : item.rank === 2 ? 'top2' : item.rank === 3 ? 'top3' : ''}`}>
                  #{item.rank}
                </span>

                <div className="rank-thumb" onClick={() => onOpenContent(item.id, 'point', item.saved_board_id)}>
                  {item.cover_url ? (
                    <img src={item.cover_url} alt={item.title} referrerPolicy="no-referrer" loading="lazy" />
                  ) : (
                    <div className="vcard-fallback-text">{PLATFORM_LABELS[item.platform] || item.platform}</div>
                  )}
                </div>

                <div style={{ minWidth: 0 }}>
                  <div
                    style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)', cursor: 'pointer', lineHeight: 1.4 }}
                    onClick={() => onOpenContent(item.id, 'point', item.saved_board_id)}
                  >
                    {item.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                    <span className="badge badge-gray">{item.source_name} · {PLATFORM_LABELS[item.platform] || item.platform}</span>
                    {item.breakout_ratio != null && item.breakout_ratio >= 1.2 && (
                      <span className="badge badge-amber">🔥 {item.breakout_ratio}x 平时均值</span>
                    )}
                    {item.latest_views != null && <span>▶ {fmtNum(item.latest_views)}</span>}
                    {item.latest_likes != null && <span>👍 {fmtNum(item.latest_likes)}</span>}
                    {item.transcript_chars > 50 && <span className="badge badge-green">已有口播稿</span>}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => onOpenRemix(item.id)}
                  >
                    <Wand2 size={13} /> 拆解与二创
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onOpenContent(item.id, 'transcript', item.saved_board_id)}
                  >
                    看口播
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
