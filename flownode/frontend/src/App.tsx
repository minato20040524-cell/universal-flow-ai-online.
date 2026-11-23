import { Header } from './components/dashboard/Header';
import { Overlays } from './components/dashboard/Dialogs';
import { Sidebar } from './components/dashboard/Sidebar';
import {
  AgentManagerView, AnalyticsView, ApprovalView, BuildersView, CollabView, DashboardView, FilesView,
  NodeEditorView, SettingsView, SkillManagerView,
} from './components/views/Views';
import { useApp } from './store';

export default function App() {
  const { s, view } = useApp();
  if (!s) {
    return <div className="grid h-full place-items-center text-sm text-slate-400">Menghubungkan ke server FLOWNODE…</div>;
  }
  const page = {
    dashboard: <DashboardView />, nodes: <NodeEditorView />, collab: <CollabView />, agents: <AgentManagerView />,
    skills: <SkillManagerView />, builders: <BuildersView />, files: <FilesView />, approvals: <ApprovalView />,
    analytics: <AnalyticsView />, settings: <SettingsView />,
  }[view];
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        {page}
      </div>
      <Overlays />
    </div>
  );
}
