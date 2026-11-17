import { useEffect, useState } from 'react';
import { LayoutDashboard, Globe2, Newspaper, Send, Monitor, ListChecks, Settings, Sparkles } from 'lucide-react';
import { OverviewPage } from './pages/OverviewPage';
import { SourcesPage } from './pages/SourcesPage';
import { ContentsPage } from './pages/ContentsPage';
import { PublishPage } from './pages/PublishPage';
import { BrowsersPage } from './pages/BrowsersPage';
import { TasksPage } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';

const NAV_ITEMS = [
  { id: 'overview', label: '监控总览', icon: LayoutDashboard },
  { id: 'sources', label: '监控对象', icon: Globe2 },
  { id: 'contents', label: '最新内容', icon: Newspaper },
  { id: 'publish', label: '视频发布', icon: Send },
  { id: 'browsers', label: '浏览器与登录', icon: Monitor },
  { id: 'tasks', label: '任务中心', icon: ListChecks },
  { id: 'settings', label: '系统设置', icon: Settings },
] as const;

export function App() {
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [toast, setToast] = useState<string | null>(null);
  const [healthOk, setHealthOk] = useState<boolean>(true);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((prev) => (prev === msg ? null : prev));
    }, 3600);
  };

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
                onClick={() => setActiveTab(item.id)}
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
          {activeTab === 'overview' && <OverviewPage onNavigate={setActiveTab} />}
          {activeTab === 'sources' && <SourcesPage onToast={showToast} />}
          {activeTab === 'contents' && <ContentsPage onToast={showToast} />}
          {activeTab === 'publish' && <PublishPage onToast={showToast} />}
          {activeTab === 'browsers' && <BrowsersPage onToast={showToast} />}
          {activeTab === 'tasks' && <TasksPage onToast={showToast} />}
          {activeTab === 'settings' && <SettingsPage onToast={showToast} />}
        </main>
      </div>

      {toast && <div className="toast-banner">{toast}</div>}
    </div>
  );
}
