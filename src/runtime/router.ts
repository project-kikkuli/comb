// router.ts — Hash-based router for Comb apps

import { createSignal, createComb, createEffect } from './signals.js';

export interface Route {
  path: string;
  component: (root: HTMLElement) => { dispose: () => void };
}

export function createRouter(routes: Route[]) {
  const [currentPath, setCurrentPath] = createSignal(
    typeof window !== 'undefined' ? (window.location.hash.slice(1) || '/') : '/',
    { name: 'router.path', module: 'Router', type: 'string' },
  );

  const currentRoute = createComb(() => {
    const path = currentPath();
    return routes.find(r => r.path === path) || routes.find(r => r.path === '*') || null;
  }, { name: 'router.route', module: 'Router', deps: ['router.path'] });

  // Listen for hash changes
  function onHashChange() {
    setCurrentPath(window.location.hash.slice(1) || '/');
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', onHashChange);
  }

  // Mount the router into a container
  function mount(container: HTMLElement) {
    let currentDispose: (() => void) | null = null;

    createEffect(() => {
      const route = currentRoute();
      // Cleanup previous
      if (currentDispose) {
        currentDispose();
        container.innerHTML = '';
      }
      // Mount new
      if (route) {
        currentDispose = route.component(container).dispose;
      }
    }, { name: 'router.mount', module: 'Router' });

    return {
      dispose() {
        if (currentDispose) currentDispose();
        if (typeof window !== 'undefined') {
          window.removeEventListener('hashchange', onHashChange);
        }
      },
    };
  }

  function navigate(path: string) {
    if (typeof window !== 'undefined') {
      window.location.hash = path;
    }
  }

  function link(path: string): string {
    return `#${path}`;
  }

  return { currentPath, currentRoute, mount, navigate, link };
}
