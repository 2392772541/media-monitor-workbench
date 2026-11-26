import { useEffect, useState } from 'react';
import {
  Zap,
  Users,
  Flame,
  Star,
  MessageSquareText,
  Send,
  Monitor,
  ListChecks,
  Settings,
} from 'lucide-react';
import { apiRequest } from './api';
import { ContentDrawer, type DrawerTab, type DrawerTarget } from './components/ContentDrawer';
import { CockpitPage } from './pages/CockpitPage';
import { CreatorsPage } from './pages/CreatorsPage';
import { HotBoardPage } from './pages/HotBoardPage';
import { TopicBoardPage } from './pages/TopicBoardPage';
import { CommentsPage } from './pages/CommentsPage';
import { PublishPage } from './pages/PublishPage';
import { BrowsersPage } from './pages/BrowsersPage';
import { TasksPage } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';
import type { HotBoardItem, PublishInspirationDraft } from './types';

// 核心工作流导航：今日速览 / 对标博主 / 平台热榜 / 简易收藏本 / 评论采集
const CORE_NAV_ITEMS = [
  { id: 'overview', label: '今日速览', sub: '一眼看清对标爆款与平台热榜', icon: Zap },
  { id: 'creators', label: '对标博主', sub: '贴主页链接盯盘，走势图红柱直标爆款', icon: Users },
  { id: 'hotboard', label: '平台热榜', sub: '分平台分类目看热榜，点开直出看点与口播', icon: Flame },
  { id: 'saved', label: '简易收藏本', sub: '随手标星存着拍，随时翻口播稿和热评', icon: Star },
  { id: 'comments', label: '评论采集', sub: '贴链接 / 搜关键词 / 抓博主热评，AI 一键提炼痛点', icon: MessageSquareText },
] as const;

// 创作分发与运维入口保留在底部
const OPS_NAV_ITEMS = [
  { id: 'publish', label: '视频发布', sub: 'AI 自动按平台写标题标签 · 多平台分发', icon: Send },
  { id: 'browsers', label: '浏览器与登录', sub: '管理后台抓取登录态（本机显卡转写已免登录）', icon: Monitor },
  { id: 'tasks', label: '任务中心', sub: '监控抓取记录、一键重试与失败清理', icon: ListChecks },
  { id: 'settings', label: '系统设置', sub: '本机大模型与抓取基础配置', icon: Settings },
] as const;

const ALL_NAV_ITEMS = [...CORE_NAV_ITEMS, ...OPS_NAV_ITEMS];

type PublishSubTab = 'publish' | 'titles' | 'accounts' | 'materials' | 'history';

// 兼容旧 Hash 路由并平滑映射到精简 4 页
function parseHashRoute(hash: string): { tab: string; publishSubTab?: PublishSubTab } {
  const cleaned = hash.replace(/^#\/?/, '').trim();
  if (!cleaned) return { tab: 'overview' };
  const [rawTab, rawSub] = cleaned.split(':');
  const aliasMap: Record<string, string> = {
    cockpit: 'overview',
    sources: 'creators',
    board: 'saved',
    radar: 'overview',
    intel: 'overview',
    contents: 'overview',
  };
  const mapped = aliasMap[rawTab] || rawTab;
  const validTab = ALL_NAV_ITEMS.some((n) => n.id === mapped) ? mapped : 'overview';
  const validSubs: PublishSubTab[] = ['publish', 'titles', 'accounts', 'materials', 'history'];
  const publishSubTab = validSubs.includes(rawSub as PublishSubTab) ? (rawSub as PublishSubTab) : undefined;
  return { tab: validTab, publishSubTab };
}

export function App() {
  const initialRoute = parseHashRoute(window.location.hash);
  const [activeTab, setActiveTab] = useState<string>(initialRoute.tab);
  const [publishSubTab, setPublishSubTab] = useState<PublishSubTab>(initialRoute.publishSubTab || 'publish');
  const [publishDraft, setPublishDraft] = useState<PublishInspirationDraft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [healthOk, setHealthOk] = useState<boolean>(true);
  const [savedCount, setSavedCount] = useState<number>(0);

  // 全站共用右侧深读抽屉（看点 / 口播稿 / 真实热评）
  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget | null>(null);
  const [refreshTick, setRefreshTick] = useState<number>(0);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3600);
  };

  const refreshSavedBadge = async () => {
    try {
      const res = await apiRequest<{ items: unknown[] }>('/api/radar/board');
      setSavedCount(res.items.length);
    } catch {
      // ignore
    }
  };

  const handleNavigate = (target: string, keepToast = false) => {
    const parsed = parseHashRoute(target);
    setActiveTab(parsed.tab);
    if (parsed.tab === 'publish') {
      const nextSub = parsed.publishSubTab || 'publish';
      setPublishSubTab(nextSub);
      const nextHash = nextSub === 'publish' ? '#publish' : `#publish:${nextSub}`;
      if (window.location.hash !== nextHash) {
        window.history.pushState(null, '', nextHash);
      }
    } else {
      const nextHash = `#${parsed.tab}`;
      if (window.location.hash !== nextHash) {
        window.history.pushState(null, '', nextHash);
      }
    }
    if (!keepToast) setToast(null);
  };

  const handlePublishSubTabChange = (sub: PublishSubTab) => {
    setPublishSubTab(sub);
    const nextHash = sub === 'publish' ? '#publish' : `#publish:${sub}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash);
    }
  };

  const handleSendToPublish = (draft: PublishInspirationDraft) => {
    setPublishDraft(draft);
    handleNavigate('publish', true);
    showToast('已将标题与来源带入「视频发布」');
  };

  // 打开博主作品或已入库条目的右侧抽屉
  const handleOpenContent = (contentId: number, initialTab: DrawerTab = 'point', savedBoardId?: number | null) => {
    setDrawerTarget({ contentId, initialTab, savedBoardId });
  };

  // 打开热榜条目的右侧抽屉（未入库时静默入库，无感知秒开）
  const handleOpenHotItem = async (item: HotBoardItem, initialTab: DrawerTab = 'point') => {
    try {
      let cid = item.content_id;
      if (!cid) {
        const res = await apiRequest<{ contentId: number }>(`/api/radar/hot-board/${item.id}/import`, { method: 'POST' });
        cid = res.contentId;
        setRefreshTick((t) => t + 1);
      }
      setDrawerTarget({ contentId: cid, initialTab, savedBoardId: item.saved_board_id });
    } catch (err) {
      showToast((err as Error).message);
    }
  };

  const handleGlobalChanged = () => {
    setRefreshTick((t) => t + 1);
    void refreshSavedBadge();
  };

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHashRoute(window.location.hash);
      setActiveTab(parsed.tab);
      if (parsed.publishSubTab) setPublishSubTab(parsed.publishSubTab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setHealthOk(r.ok))
      .catch(() => setHealthOk(false));
    void refreshSavedBadge();
  }, []);

  const currentNav = ALL_NAV_ITEMS.find((n) => n.id === activeTab) || CORE_NAV_ITEMS[0];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <Flame size={19} />
          </div>
          <div>
            <div className="brand-title">爆款与热榜监控台</div>
            <div className="brand-sub">盯博主 · 看热榜 · 一键扒稿</div>
          </div>
        </div>

        <nav className="nav-list">
          <div className="nav-section-label">核心监控</div>
          {CORE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                data-testid={`nav-${item.id}`}
                className={`nav-btn ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => handleNavigate(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.id === 'saved' && savedCount > 0 && <span className="nav-count">{savedCount}</span>}
              </button>
            );
          })}

          <div className="nav-section-label">创作与工具</div>
          {OPS_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                data-testid={`nav-${item.id}`}
                className={`nav-btn ${activeTab === item.id ? 'active' : ''}`}
                onClick={() => handleNavigate(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div>单端口运行：127.0.0.1:18910</div>
          <div style={{ marginTop: 5 }}>
            状态：
            {healthOk ? (
              <span style={{ color: '#4ade80', fontWeight: 600 }}>● 在线运行中</span>
            ) : (
              <span style={{ color: '#f87171', fontWeight: 600 }}>● 未连接</span>
            )}
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-inner">
            <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 4 }}>
              <div className="topbar-title">{currentNav.label}</div>
              <span className="topbar-sub">{currentNav.sub}</span>
            </div>
            <div className="topbar-pill">
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: healthOk ? '#16a34a' : '#dc2626',
                  display: 'inline-block',
                }}
              />
              <span>单端口 18910</span>
            </div>
          </div>
        </header>

        <main className="page-body">
          {activeTab === 'overview' && (
            <CockpitPage
              refreshTick={refreshTick}
              onNavigate={handleNavigate}
              onOpenContent={handleOpenContent}
              onOpenHotItem={handleOpenHotItem}
              onRefreshBadge={handleGlobalChanged}
              onToast={showToast}
            />
          )}
          {activeTab === 'creators' && (
            <CreatorsPage
              refreshTick={refreshTick}
              onNavigate={handleNavigate}
              onOpenContent={handleOpenContent}
              onRefreshBadge={handleGlobalChanged}
              onToast={showToast}
            />
          )}
          {activeTab === 'hotboard' && (
            <HotBoardPage
              refreshTick={refreshTick}
              onOpenHotItem={handleOpenHotItem}
              onRefreshBadge={handleGlobalChanged}
              onToast={showToast}
            />
          )}
          {activeTab === 'saved' && (
            <TopicBoardPage
              refreshTick={refreshTick}
              onOpenContent={handleOpenContent}
              onSendToPublish={handleSendToPublish}
              onRefreshBadge={handleGlobalChanged}
              onToast={showToast}
            />
          )}
          {activeTab === 'comments' && (
            <CommentsPage onToast={showToast} onNavigate={handleNavigate} />
          )}
          {activeTab === 'publish' && (
            <PublishPage
              onToast={showToast}
              activeSubTab={publishSubTab}
              onSubTabChange={handlePublishSubTabChange}
              inspirationDraft={publishDraft}
              onClearInspiration={() => setPublishDraft(null)}
            />
          )}
          {activeTab === 'browsers' && <BrowsersPage onToast={showToast} onNavigate={handleNavigate} />}
          {activeTab === 'tasks' && <TasksPage onToast={showToast} onNavigate={handleNavigate} />}
          {activeTab === 'settings' && <SettingsPage onToast={showToast} />}
        </main>
      </div>

      <ContentDrawer
        target={drawerTarget}
        onClose={() => setDrawerTarget(null)}
        onChanged={handleGlobalChanged}
        onSendToPublish={handleSendToPublish}
        onToast={showToast}
      />

      {toast && <div className="toast-banner">{toast}</div>}
    </div>
  );
}
