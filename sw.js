/**
 * VillaST admin service worker — push only. Scope: /admin
 *
 * No fetch handler on purpose: it caches nothing, so the public site and the
 * admin page keep behaving exactly as without a service worker.
 * The Firebase config mirrors js/firebase-config.js (service workers load the
 * compat SDK via importScripts, which cannot import that ES module).
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDL0y9ztdnM_5-fFmla-rBZpeRaSRTM3OQ",
  authDomain: "villa-serenita-san-teodoro.firebaseapp.com",
  projectId: "villa-serenita-san-teodoro",
  storageBucket: "villa-serenita-san-teodoro.firebasestorage.app",
  messagingSenderId: "125678913278",
  appId: "1:125678913278:web:e7f799921d339647bfc7af"
});

const messaging = firebase.messaging();

// ponytail: no onBackgroundMessage — the SDK displays the `notification` payload
// itself (title/body/icon/tag come from the notifier's webpush.notification block).
// Showing it here too displayed every push twice; `notificationclick` below still runs.


self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/admin';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes('/admin')) return client.focus();
      }
      return self.clients.openWindow(link);
    })
  );
});
