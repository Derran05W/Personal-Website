import type { RouteObject } from 'react-router';
import App from '../App';
import Credits from './routes/Credits';
import Home from './routes/Home';
import NotFound from './routes/NotFound';
import Portfolio from './routes/Portfolio';
import Resume from './routes/Resume';

// The route table, as pure data — no `createBrowserRouter(...)` call here. That call
// (in router.tsx) has a real side effect at module-eval time: it constructs a browser
// History object, which reaches for `document`/`window` immediately, not lazily. Any
// module that imports router.tsx therefore can't be evaluated outside a real browser —
// which is exactly what src/entry-server.tsx needs to do (it renders this same route
// table under `<StaticRouter>` for prerendering, in plain Node, via `useRoutes(routes)`
// — see that file's header). Splitting the data out here keeps `routes` importable from
// anywhere, and confines the browser-only side effect to router.tsx, imported only by
// main.tsx (the real client entry).
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: 'portfolio', element: <Portfolio /> },
      { path: 'resume', element: <Resume /> },
      { path: 'credits', element: <Credits /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
