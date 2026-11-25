import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Users,
  Flame,
  Radar,
  Database,
  KanbanSquare,
  Send,
  Monitor,
  ListChecks,
  Settings,
  Sparkles,
  Sliders,
} from 'lucide-react';
import { apiRequest } from './api';
import { AccountModal } from './components/AccountModal';
import { CockpitPage } from './pages/CockpitPage';
import { CreatorsPage } from './pages/CreatorsPage';
import { HotBoardPage } from './pages/HotBoardPage';
import { TopicRadarPage } from './pages/TopicRadarPage';
import { IntelLibraryPage } from './pages/IntelLibraryPage';
import { TopicBoardPage } from './pages/TopicBoardPage';
import { PublishPage } from './pages/PublishPage';
import { BrowsersPage } from './pages/BrowsersPage';
import { TasksPage } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';
import type { CreatorAccount, PublishInspirationDraft } from './types';

// 核心六大选题监控页面
const RADAR_NAV_ITEMS = [
  { id: 'cockpit', label: '选题驾驶舱', icon: LayoutDashboard },
  { id: 'creators', label: '博主监控', icon: Users },
  { id: 'hotboard', label: '行业热榜', icon: Flame },
  { id: 'radar', label: '话题雷达', icon: Radar },
  { id: 'intel', label: '内容情报库', icon: Database },
  { id: 'board', label: '个人选题库', icon: KanbanSquare },
] as const;

// 原有创作分发与底层运维入口（完整保留不破坏）
const OPS_NAV_ITEMS = [
  { id: 'publish', label: '视频发布', icon: Send },
  { id: 'browsers', label: '浏览器与登录', icon: Monitor },
  { id: 'tasks', label: '任务中心', icon: ListChecks },
  { id: 'settings', label: '系统设置', icon: Settings },
] as const;

const ALL_NAV_ITEMS = [...RADAR_NAV_ITEMS, ...OPS_NAV_ITEMS];

type PublishSubTab = 'publish' | 'titles' | 'accounts' | 'materials' | 'history';

// 兼容旧 Hash 路由并映射到新六大工作台页面
function parseHashRoute(hash: string): { tab: string; publishSubTab?: PublishSubTab } {
  const cleaned = hash.replace(/^#\/?/, '').trim();
  if (!cleaned) return { tab: 'cockpit' };
  const [rawTab, rawSub] = cleaned.split(':');
  const aliasMap: Record<string, string> = {
    overview: 'cockpit',
    sources: 'creators',
    contents: 'intel',
  };
  const mapped = aliasMap[rawTab] || rawTab;
  const validTab = ALL_NAV_ITEMS.some((n) => n.id === mapped) ? mapped : 'cockpit';
  const validSubs: PublishSubTab[] = ['publish', 'titles', 'accounts', 'materials', 'history'];
  const publishSubTab = validSubs.includes(rawSub as PublishSubTab) ? (rawSub as PublishSubTab) : undefined;
  return { tab: validTab, publishSubTab };
}

export function App() {
  const initialRoute = parseHashRoute(window.location.hash);
  const [activeTab, setActiveTab] = useState<string>(initialRoute.tab);
  const [publishSubTab, setPublishSubTab] = useState<PublishSubTab>(initialRoute.publishSubTab || 'publish');
  const [publishDraft, setPublishDraft] = useState<PublishInspirationDraft | null>(null);
  const [pendingIntelId, setPendingIntelId] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [healthOk, setHealthOk] = useState<boolean>(true);

  // 多自媒体账号定位全局状态
  const [accounts, setAccounts] = useState<CreatorAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<number>(0);
  const [showAccountModal, setShowAccountModal] = useState<boolean>(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3800);
  };

  const loadAccounts = async (preferId?: number) => {
    try {
      const list = await apiRequest<CreatorAccount[]>('/api/radar/accounts');
      setAccounts(list);
      const picked =
        (preferId && list.find((a) => a.id === preferId)) ||
        list.find((a) => a.is_active === 1) ||
        list[0];
      if (picked) setActiveAccountId(picked.id);
    } catch {
      // ignore
    }
  };

  const handleSwitchAccount = async (nextId: number) => {
    setActiveAccountId(nextId);
    try {
      await apiRequest(`/api/radar/accounts/${nextId}/activate`, { method: 'POST' });
      const acc = accounts.find((a) => a.id === nextId);
      if (acc) showToast(`已切换当前账号视角：${acc.name}`);
      await loadAccounts(nextId);
    } catch (err) {
      showToast((err as Error).message);
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
    showToast('已将选题标题与话题带入「视频发布」');
  };

  const handleOpenIntelDetail = (contentId: number) => {
    setPendingIntelId(contentId);
    handleNavigate('intel', true);
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
    void loadAccounts();
  }, []);

  const activeLabel = ALL_NAV_ITEMS.find((n) => n.id === activeTab)?.label || '选题驾驶舱';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <Sparkles size={19} />
          </div>
          <div>
            <div className="brand-title">自媒体选题编辑部</div>
            <div className="brand-sub">监控雷达 · AI推题 · 批量发布</div>
          </div>
        </div>

        <nav className="nav-list">
          <div className="nav-section-label">选题监控中心</div>
          {RADAR_NAV_ITEMS.map((item) => {
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

          <div className="nav-section-label">创作与运维</div>
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
          <div>唯一单端口：127.0.0.1:18910</div>
          <div style={{ marginTop: 5 }}>
            状态：
            {healthOk ? (
              <span style={{ color: '#4ade80', fontWeight: 600 }}>● 一体化运行中</span>
            ) : (
              <span style={{ color: '#f87171', fontWeight: 600 }}>● 未连接</span>
            )}
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-inner">
            <div className="topbar-title">{activeLabel}</div>
            <div className="topbar-controls">
              {accounts.length > 0 && (
                <div className="account-switcher">
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>当前账号：</span>
                  <select
                    value={activeAccountId}
                    onChange={(e) => void handleSwitchAccount(Number(e.target.value))}
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setShowAccountModal(true)}
                data-testid="open-account-modal"
              >
                <Sliders size={13} /> 账号定位与权重
              </button>
            </div>
          </div>
        </header>

        <main className="page-body">
          {activeTab === 'cockpit' && (
            <CockpitPage
              activeAccountId={activeAccountId}
              onNavigate={handleNavigate}
              onOpenAccountModal={() => setShowAccountModal(true)}
              onSendToPublish={handleSendToPublish}
              onOpenIntelDetail={handleOpenIntelDetail}
              onToast={showToast}
            />
          )}
          {activeTab === 'creators' && (
            <CreatorsPage
              onToast={showToast}
              onNavigate={handleNavigate}
              onOpenIntelDetail={handleOpenIntelDetail}
            />
          )}
          {activeTab === 'hotboard' && (
            <HotBoardPage
              activeAccountId={activeAccountId}
              onToast={showToast}
              onOpenIntelDetail={handleOpenIntelDetail}
            />
          )}
          {activeTab === 'radar' && (
            <TopicRadarPage
              activeAccountId={activeAccountId}
              onToast={showToast}
              onOpenIntelDetail={handleOpenIntelDetail}
            />
          )}
          {activeTab === 'intel' && (
            <IntelLibraryPage
              activeAccountId={activeAccountId}
              initialContentId={pendingIntelId}
              onClearInitialContent={() => setPendingIntelId(null)}
              onSendToPublish={handleSendToPublish}
              onToast={showToast}
            />
          )}
          {activeTab === 'board' && (
            <TopicBoardPage
              activeAccountId={activeAccountId}
              onSendToPublish={handleSendToPublish}
              onToast={showToast}
            />
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

      <AccountModal
        open={showAccountModal}
        accounts={accounts}
        activeAccountId={activeAccountId}
        onClose={() => setShowAccountModal(false)}
        onChanged={(newId) => void loadAccounts(newId)}
        onToast={showToast}
      />

      {toast && <div className="toast-banner">{toast}</div>}
    </div>
  );
}
