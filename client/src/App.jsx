import { React, useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import NavBar from './components/NavBar/NavBar.jsx';
import LoginPage from './pages/LoginPage.jsx';
import FileTree from './components/FileTree/FileTree.jsx';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import LandingPage from './pages/LandingPage.jsx';
import ResponseArea from './components/ResponseArea/ResponseArea.jsx';
import SubmissionTimeline from './components/SubmissionTimeline/SubmissionTimeline.jsx';
import CodeEditor from './components/CodeEditor/CodeEditor.jsx';
import GroupsPage from './pages/GroupsPage.jsx';
import GroupPage from './pages/GroupPage.jsx';

import './App.css';

// Main authenticated layout
function DashboardLayout() {
  const { user, signOut } = useAuth();

  return (
    <main className="app-shell page-enter">
      <header className="app-header">
        <p>
          You are signed in as <strong>{user?.username}</strong>
        </p>
        <button type="button" className="app-signout" onClick={signOut}>
          Sign out
        </button>
      </header>

      {/* P4 file tree */}
      <FileTree />
    </main>
  );
}

// Shared layout for authenticated pages: nav bar above the page content
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
  const [groupId, setGroupId] = useState(null);

  if (loading) {
    return <p style={{ margin: 'auto' }}>Loading...</p>;
  }

  return (
    <>
      {/*groupId ? (<GroupPage groupId={groupId} onBack={() => setGroupId(null)} />) : (<GroupsPage onOpen={setGroupId} />)*/}

      <Routes>
        {/* Public Route */}
        <Route
          path="/login"
          element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />}
        />

        {/* Protected Routes */}
        <Route element={<ProtectedRoute />}>
          <Route element={<NavLayout />}>
            <Route path="/dashboard" element={<DashboardLayout />} />
            <Route path="/home" element={<LandingPage />} />
            <Route path="/code" element={<ResponseArea />} />
            <Route path="/codes" element={<SubmissionTimeline />} />
            <Route path="/coding" element={<CodeEditor />} />
            <Route path="/code-editor" element={<CodeEditor />} />
            <Route
              path="/groups"
              element={
                groupId ? (
                  <GroupPage
                    groupId={groupId}
                    onBack={() => setGroupId(null)}
                  />
                ) : (
                  <GroupsPage onOpen={setGroupId} />
                )
              }
            />
            {/* Add additional protected routes here (e.g. /profile, /settings) */}
          </Route>
        </Route>

        {/* Root redirect */}
        <Route
          path="/"
          element={<Navigate to={user ? '/dashboard' : '/login'} replace />}
        />

        {/* Fallback 404 / Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </>
  );
}
