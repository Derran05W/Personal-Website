import { Outlet } from 'react-router';
import Header from './app/Header';

// Persistent root shell: rendered by every route via router.tsx's layout route.
// Skip link is the first focusable element in the DOM (standard pattern); Header stays
// mounted and tabbable on every route, including 404.
function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Header />
      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

export default App;
