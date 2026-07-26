'use strict';

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js', {
      scope: './',
      updateViaCache: 'all',
    }).catch((error) => {
      console.warn('오프라인 캐시를 시작하지 못했습니다.', error);
    });
  });
}
