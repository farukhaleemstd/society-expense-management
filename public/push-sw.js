self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = { body: event.data ? event.data.text() : '' }
  }

  const title = typeof message.title === 'string' ? message.title : 'Society Maintenance'
  const options = {
    body: typeof message.body === 'string' ? message.body : 'You have a new society account update.',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    data: { url: typeof message.url === 'string' ? message.url : '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const requestedUrl = new URL(event.notification.data?.url || '/', self.location.origin)
  const targetUrl = requestedUrl.origin === self.location.origin ? requestedUrl.href : self.location.origin
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const appClient = clients.find((client) => new URL(client.url).origin === self.location.origin)
    if (appClient) {
      appClient.navigate(targetUrl)
      return appClient.focus()
    }
    return self.clients.openWindow(targetUrl)
  }))
})
