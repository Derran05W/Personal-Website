import { createBrowserRouter } from 'react-router';
import App from '../App';
import Home from './routes/Home';
import NotFound from './routes/NotFound';
import Portfolio from './routes/Portfolio';
import Resume from './routes/Resume';

// Data router (react-router v8, "Data mode"): current idiomatic top-level API for a
// plain Vite SPA — see main.tsx for the paired <RouterProvider> (imported from
// "react-router/dom", not "react-router", as of v8).
//
// All routes nest under <App>, the persistent shell layout (skip link + Header + the
// #main-content landmark that <Outlet/> renders into) — so the header and skip link
// stay present, tabbable, and consistent on every route, including 404.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'portfolio', element: <Portfolio /> },
      { path: 'resume', element: <Resume /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
