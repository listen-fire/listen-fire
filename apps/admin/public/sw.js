self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  const title = data.title || 'Listen-Fire';
  const options = {
    body: data.body || '',
    data: { eventId: data.eventId || null },
    tag: data.eventId || undefined,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.eventId;
  const url = id ? `/feed/${id}` : '/feed';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ('focus' in w) { w.navigate(url); return w.focus(); } }
      return clients.openWindow(url);
    }),
  );
});
