import { useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';

import LoginPage from './pages/LoginPage.jsx';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import LandingPage from './pages/LandingPage.jsx';
import CodeEditor from './components/CodeEditor/CodeEditor.jsx';
import GroupsPage from './pages/GroupsPage.jsx';
import GroupPage from './pages/GroupPage.jsx';
import NavBar from './components/NavBar/NavBar.jsx';
import { NotificationsProvider } from './notifications/NotificationsContext.jsx';

import './App.css';

// Main authenticated dashboard: the user's groups, or one group's page.
function DashboardLayout() {
  const [groupId, setGroupId] = useState(null);

  return (
    <main className="app-shell">
      {groupId ? (
        <GroupPage groupId={groupId} onBack={() => setGroupId(null)} />
      ) : (
        <GroupsPage onOpen={setGroupId} />
      )}
    </main>
  );
}

// Shared layout for authenticated pages.
function NavLayout() {
  return (
    <>
      <NavBar />
      <Outlet />
    </>
  );
}

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return <p style={{ margin: 'auto' }}>Loading...</p>;
  }

  return (
    <Routes>
      {/* Public route */}
      <Route
        path="/login"
        element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />}
      />

      {/* Protected routes */}
      <Route element={<ProtectedRoute />}>
        <Route element={<NavLayout />}>
          <Route path="/home" element={<LandingPage />} />
          <Route path="/dashboard" element={<DashboardLayout />} />
          <Route path="/coding" element={<CodeEditor />} />
          {/* Old links */}
          <Route
            path="/groups"
            element={<Navigate to="/dashboard" replace />}
          />
          <Route
            path="/code-editor"
            element={<Navigate to="/coding" replace />}
          />
        </Route>
      </Route>

      {/* Root redirect */}
      <Route
        path="/"
        element={<Navigate to={user ? '/dashboard' : '/login'} replace />}
      />

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      {/* Inside AuthProvider because it needs to know who is signed in */}
      <NotificationsProvider>
        <AppRoutes />
      </NotificationsProvider>
    </AuthProvider>
  );
}
