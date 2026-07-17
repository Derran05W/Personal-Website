import { Outlet } from 'react-router';
import Header from './app/Header';
import Footer from './app/Footer';
import RouteMetaSync from './app/RouteMetaSync';
import AppAnalytics from './app/AppAnalytics';

// Persistent root shell: rendered by every route via router.tsx's layout route.
// Skip link is the first focusable element in the DOM (standard pattern); Header stays
// mounted and tabbable on every route, including 404.
//
// RouteMetaSync/AppAnalytics render null (no visible markup) — mounted here so they
// observe every route for the app's whole lifetime, same as Header.
function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <RouteMetaSync />
      <AppAnalytics />
      <Header />
      {/* aria-label (Phase 20 QA FILED-3): while the game is live, Home's hero (and its
          h1) is aria-hidden — this label keeps the main landmark identifiable to AT
          without adding a second h1 (which would break the heading-structure contract). */}
      <main id="main-content" tabIndex={-1} aria-label="Smashy the 6ix">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

export default App;
