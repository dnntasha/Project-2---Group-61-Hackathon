/**
 * A tiny client-side router with the same API as the parts of
 * react-router-dom this app uses.
 *
 * The spec (section 15) only allows React, Express, WebSockets, multer and JWT
 * libraries. Rather than rewrite the pages, this file provides the same names
 * (BrowserRouter, Routes, Route, Outlet, Navigate, Link, NavLink, useNavigate,
 * useLocation, useSearchParams), so every existing file only changes its
 * import line from 'react-router-dom' to this file.
 *
 * Supported: exact paths ("/dashboard"), "*" as a catch-all, and layout
 * routes (a <Route> without a path whose children render in its <Outlet />).
 * Navigation uses the History API, so the back button works.
 */
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const RouterContext = createContext(null);
// What a layout route's <Outlet /> should render
const OutletContext = createContext(null);

function currentLocation() {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

// Holds the current location and re-renders the app when it changes
export function BrowserRouter({ children }) {
  const [location, setLocation] = useState(currentLocation);

  // Back/forward buttons change the URL without telling React
  useEffect(() => {
    const onPopState = () => setLocation(currentLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to, { replace = false } = {}) => {
    const target = String(to);
    if (target === window.location.pathname + window.location.search) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', target);
    setLocation(currentLocation());
  }, []);

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNavigate() {
  return useContext(RouterContext).navigate;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLocation() {
  return useContext(RouterContext).location;
}

// Like react-router: returns [params, setParams]
// eslint-disable-next-line react-refresh/only-export-components
export function useSearchParams() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new window.URLSearchParams(search), [search]);
  const setParams = useCallback(
    (next) => {
      const query = new window.URLSearchParams(next).toString();
      navigate(query ? `${pathname}?${query}` : pathname);
    },
    [navigate, pathname]
  );
  return [params, setParams];
}

// A <Route> only describes a route; <Routes> reads its props
export function Route() {
  return null;
}

// Finds the first <Route> matching the path. A route without a path is a
// layout: if one of its children matches, the layout's element is rendered
// and the matching child is shown where the layout puts <Outlet />.
function matchRoutes(children, pathname) {
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const { path, element, children: nested } = child.props;

    if (nested) {
      const inner = matchRoutes(nested, pathname);
      if (inner !== null) {
        return (
          <OutletContext.Provider value={inner}>
            {element}
          </OutletContext.Provider>
        );
      }
      continue;
    }

    if (path === pathname || path === '*') return element ?? null;
  }
  return null;
}

export function Routes({ children }) {
  const { pathname } = useLocation();
  return matchRoutes(children, pathname);
}

// Where a layout route shows the child route that matched
export function Outlet() {
  return useContext(OutletContext);
}

// An <a> that changes page without reloading. Modified clicks (new tab, etc.)
// are left to the browser.
export function Link({ to, onClick, children, ...props }) {
  const navigate = useNavigate();

  function handleClick(event) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(to);
  }

  return (
    <a href={to} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}

// A Link that knows whether it points at the current page
export function NavLink({ to, className, children, ...props }) {
  const { pathname } = useLocation();
  const isActive = pathname === to;
  return (
    <Link
      to={to}
      className={
        typeof className === 'function' ? className({ isActive }) : className
      }
      aria-current={isActive ? 'page' : undefined}
      {...props}
    >
      {children}
    </Link>
  );
}

// Redirects as soon as it renders
export function Navigate({ to, replace = false }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace });
  }, [navigate, to, replace]);
  return null;
}
