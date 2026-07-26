'use strict';

const CACHE_PREFIX = 'jjal-generator-static-';
const CACHE_NAME = __CACHE_NAME__;
const APP_FILES = __APP_FILES__;
const APP_ROOT = new URL('./', self.location.href);

function appUrl(relativePath) {
  return new URL(relativePath, APP_ROOT).href;
}

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(APP_FILES.map(async (relativePath) => {
    const url = appUrl(relativePath);
    const response = await fetch(new Request(url, {
      cache: 'reload',
      credentials: 'same-origin',
    }));
    if (!response.ok) throw new Error(`정적 파일 캐시 실패: ${url}`);
    await cache.put(url, response);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;

    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      if (request.mode === 'navigate') {
        const appShell = await caches.match(appUrl('./'));
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});
