import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ConfirmHost } from './components/ConfirmDialog.tsx';
import { FolderPickerHost } from './components/library/FolderPicker.tsx';
import { Spinner, Toasts } from './components/ui.tsx';
import { useServerEvents } from './lib/events.ts';
import { useStore } from './lib/store.ts';

// 路由级代码分割：首页与工作台分开加载，首屏更轻
const Landing = lazy(() => import('./pages/Landing.tsx'));
const Auth = lazy(() => import('./pages/Auth.tsx'));
const StudioLayout = lazy(() => import('./pages/studio/Layout.tsx'));
const Create = lazy(() => import('./pages/studio/Create.tsx'));
const Inspire = lazy(() => import('./pages/studio/Inspire.tsx'));
const Stories = lazy(() => import('./pages/studio/Stories.tsx'));
const StoryEditor = lazy(() => import('./pages/studio/StoryEditor.tsx'));
const Series = lazy(() => import('./pages/studio/Series.tsx'));
const Queue = lazy(() => import('./pages/studio/Queue.tsx'));
const Assets = lazy(() => import('./pages/studio/Assets.tsx'));
const Settings = lazy(() => import('./pages/studio/Settings.tsx'));
// 管理后台单独分包，普通用户不会下载
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout.tsx'));
const AdminOverview = lazy(() => import('./pages/admin/Overview.tsx'));
const AdminOperatorList = lazy(() => import('./pages/admin/Operators.tsx').then((m) => ({ default: m.OperatorList })));
const AdminOperatorDetail = lazy(() => import('./pages/admin/Operators.tsx').then((m) => ({ default: m.OperatorDetail })));
const AdminTasks = lazy(() => import('./pages/admin/Tasks.tsx'));
const AdminUsers = lazy(() => import('./pages/admin/Users.tsx'));
const AdminBackups = lazy(() => import('./pages/admin/Backups.tsx'));
const AdminAudit = lazy(() => import('./pages/admin/Audit.tsx'));
const AdminContent = lazy(() => import('./pages/admin/Content.tsx'));

function FullscreenLoader() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Spinner />
    </div>
  );
}

/** 后台只对管理员开放；其他人当作页面不存在 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const ready = useStore((state) => state.ready);
  const user = useStore((state) => state.user);
  const location = useLocation();
  if (!ready) return <FullscreenLoader />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!user.isAdmin) return <Navigate to="/studio/create" replace />;
  return <>{children}</>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const ready = useStore((state) => state.ready);
  const user = useStore((state) => state.user);
  const location = useLocation();
  if (!ready) return <FullscreenLoader />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children}</>;
}

export default function App() {
  const user = useStore((state) => state.user);
  const location = useLocation();
  useServerEvents(Boolean(user));

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <>
      <Suspense fallback={<FullscreenLoader />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />
          <Route
            path="/studio"
            element={
              <RequireAuth>
                <StudioLayout />
              </RequireAuth>
            }
          >
            <Route index element={<Navigate to="create" replace />} />
            <Route path="create" element={<Create />} />
            <Route path="inspire" element={<Inspire />} />
            <Route path="stories" element={<Stories />} />
            <Route path="stories/:id" element={<StoryEditor />} />
            <Route path="series/:id" element={<Series />} />
            <Route path="queue" element={<Queue />} />
            <Route path="assets" element={<Assets />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminLayout />
              </RequireAdmin>
            }
          >
            <Route index element={<AdminOverview />} />
            <Route path="operators" element={<AdminOperatorList />} />
            <Route path="operators/:id" element={<AdminOperatorDetail />} />
            <Route path="tasks" element={<AdminTasks />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="content" element={<AdminContent />} />
            <Route path="backups" element={<AdminBackups />} />
            <Route path="audit" element={<AdminAudit />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toasts />
      <ConfirmHost />
      <FolderPickerHost />
    </>
  );
}
