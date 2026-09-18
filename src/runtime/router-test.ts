// router-test.ts — Tests for hash router

import { circuit } from './circuit.js';
import { createRouter, type Route } from './router.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// Mock window.location.hash for initial state
if (typeof globalThis.window === 'undefined') {
  (globalThis as any).window = {
    location: { hash: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

console.log('\n  Router Tests\n');

// Test 1: Initial path defaults to '/'
{
  circuit.reset();
  window.location.hash = '';
  const routes: Route[] = [
    { path: '/', component: (root) => ({ dispose: () => {} }) },
    { path: '/about', component: (root) => ({ dispose: () => {} }) },
  ];
  const router = createRouter(routes);
  assert(router.currentPath() === '/', 'Initial path defaults to /');
}

// Test 2: Route matching finds correct route
{
  circuit.reset();
  window.location.hash = '#/about';
  const aboutComponent = (root: HTMLElement) => ({ dispose: () => {} });
  const routes: Route[] = [
    { path: '/', component: (root) => ({ dispose: () => {} }) },
    { path: '/about', component: aboutComponent },
  ];
  const router = createRouter(routes);
  assert(router.currentPath() === '/about', 'Reads hash to determine path');
  assert(router.currentRoute()?.path === '/about', 'Matches /about route');
}

// Test 3: Wildcard route acts as fallback
{
  circuit.reset();
  window.location.hash = '#/nonexistent';
  const fallback = (root: HTMLElement) => ({ dispose: () => {} });
  const routes: Route[] = [
    { path: '/', component: (root) => ({ dispose: () => {} }) },
    { path: '*', component: fallback },
  ];
  const router = createRouter(routes);
  assert(router.currentRoute()?.path === '*', 'Wildcard matches unknown paths');
}

// Test 4: No match returns null
{
  circuit.reset();
  window.location.hash = '#/unknown';
  const routes: Route[] = [
    { path: '/', component: (root) => ({ dispose: () => {} }) },
  ];
  const router = createRouter(routes);
  assert(router.currentRoute() === null, 'Returns null when no route matches');
}

// Test 5: link() returns hash URL
{
  circuit.reset();
  window.location.hash = '';
  const routes: Route[] = [
    { path: '/', component: (root) => ({ dispose: () => {} }) },
  ];
  const router = createRouter(routes);
  assert(router.link('/about') === '#/about', 'link() returns hash prefixed path');
}

// Test 6: navigate() doesn't throw in SSR (no window)
{
  circuit.reset();
  const originalWindow = (globalThis as any).window;
  delete (globalThis as any).window;

  let didThrow = false;
  try {
    const routes: Route[] = [
      { path: '/', component: (root) => ({ dispose: () => {} }) },
    ];
    const router = createRouter(routes);
    router.navigate('/about'); // Should not throw
  } catch (e) {
    didThrow = true;
  } finally {
    (globalThis as any).window = originalWindow;
  }

  assert(!didThrow, 'navigate() does not throw when window is undefined');
}

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
