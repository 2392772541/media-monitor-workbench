import { useEffect, useState } from 'react';
import { LayoutDashboard, Globe2, Newspaper, Send, Monitor, ListChecks, Settings, Sparkles } from 'lucide-react';
import { OverviewPage } from './pages/OverviewPage';
import { SourcesPage } from './pages/SourcesPage';
import { ContentsPage } from './pages/ContentsPage';
import { PublishPage } from './pages/PublishPage';
import { BrowsersPage } from './pages/BrowsersPage';
import { TasksPage } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';
import type { PublishInspirationDraft } from './types';

const NAV_ITEMS = [
  { id: 'overview', label: '监控总览', icon: LayoutDashboard },
  { id: 'sources', label: '监控对象', icon: Globe2 },
  { id: 'contents', label: '最新内容', icon: Newspaper },
  { id: 'publish', label: '视频发布', icon: Send },
  { id: 'browsers', label: '浏览器与登录', icon: Monitor },
  { id: 'tasks', label: '任务中心', icon: ListChecks },
  { id: 'settings', label: '系统设置', icon: Settings },
] as const;

type PublishSubTab = 'publish' | 'titles' | 'accounts' | 'materials' | 'history';

// 解析 URL Hash 为一级页面与视频发布二级标签
function parseHashRoute(hash: string): { tab: string; publishSubTab?: PublishSubTab } {
  const cleaned = hash.replace(/^#\/?/, '').trim();
  if (!cleaned) return { tab: 'overview' };
  const [rawTab, rawSub] = cleaned.split(':');
  const validTab = NAV_ITEMS.some((n) => n.id === rawTab) ? rawTab : 'overview';
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

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3600);
  };

  // 统一导航处理：同步 URL Hash 并清理跨页残留 Toast
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
    if (!keepToast) {
      setToast(null);
    }
  };

  const handlePublishSubTabChange = (sub: PublishSubTab) => {
    setPublishSubTab(sub);
    const nextHash = sub === 'publish' ? '#publish' : `#publish:${sub}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash);
    }
  };

  // 将监控到的爆款内容一键带入视频发布工作台进行二创分发
  const handleSendToPublish = (draft: PublishInspirationDraft) => {
    setPublishDraft(draft);
    handleNavigate('publish', true);
    showToast('已将爆款选题标题与话题带入「视频发布」');
  };

  useEffect(() => {
    const onHashChange = () => {
      const parsed = parseHashRoute(window.location.hash);
      setActiveTab(parsed.tab);
      if (parsed.publishSubTab) {
        setPublishSubTab(parsed.publishSubTab);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => setHealthOk(r.ok))
      .catch(() => setHealthOk(false));
  }, []);

  const activeLabel = NAV_ITEMS.find((n) => n.id === activeTab)?.label || '监控总览';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <Sparkles size={19} />
          </div>
          <div>
            <div className="brand-title">自媒体工作台</div>
            <div className="brand-sub">监控 · 批量发布一体化</div>
          </div>
        </div>
        <nav className="nav-list">
          {NAV_ITEMS.map((item) => {
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
          <div>服务绑定：127.0.0.1</div>
          <div style={{ marginTop: 5 }}>
            状态：{healthOk ? <span style={{ color: '#4ade80', fontWeight: 600 }}>● 后台运行中</span> : <span style={{ color: '#f87171', fontWeight: 600 }}>● 未连接</span>}
          </div>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-inner">
            <div className="topbar-title">{activeLabel}</div>
            <div className="topbar-pill">
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: healthOk ? 'var(--success)' : 'var(--danger)' }} />
              <span>主浏览器完全隔离 · 数据本地持久化</span>
            </div>
          </div>
        </header>

        <main className="page-body">
          {activeTab === 'overview' && <OverviewPage onNavigate={handleNavigate} onToast={showToast} />}
          {activeTab === 'sources' && <SourcesPage onToast={showToast} onNavigate={handleNavigate} />}
          {activeTab === 'contents' && <ContentsPage onToast={showToast} onSendToPublish={handleSendToPublish} />}
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

      {toast && <div className="toast-banner">{toast}</div>}
    </div>
  );
}
