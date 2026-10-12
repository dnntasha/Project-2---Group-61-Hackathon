import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

export function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <p style={{ margin: 'auto' }}>Loading...</p>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
