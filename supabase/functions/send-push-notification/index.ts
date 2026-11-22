import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function tokenRole(authorization: string): string | null {
  try {
    const token = authorization.replace(/^Bearer\s+/i, '')
    const payload = token.split('.')[1]
    if (!payload) return null
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))).role ?? null
  } catch {
    return null
  }
}

function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) return false
    const hostname = url.hostname.toLowerCase()
    return hostname === 'fcm.googleapis.com'
      || hostname === 'android.googleapis.com'
      || hostname === 'push.services.mozilla.com'
      || hostname.endsWith('.push.services.mozilla.com')
      || hostname.endsWith('.notify.windows.com')
      || hostname.endsWith('.push.apple.com')
  } catch {
    return false
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')
  const subject = Deno.env.get('VAPID_SUBJECT')
  const authorization = request.headers.get('Authorization')
  if (!url || !anonKey || !serviceRoleKey || !publicKey || !privateKey || !subject || !authorization) {
    return jsonResponse({ error: 'Push sender configuration or authorization is missing' }, 500)
  }

  let body: { action?: string; record?: { id?: string }; notification_id?: string; days_before_due?: number; days_after_due?: number }
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'Request body must be valid JSON' }, 400)
  }
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'Request body must be a JSON object' }, 400)

  const role = tokenRole(authorization)
  const serviceClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  let callerId: string | null = null
  if (role !== 'service_role') {
    const callerClient = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: userError } = await callerClient.auth.getUser()
    if (userError || !user) return jsonResponse({ error: 'A valid signed-in account is required' }, 401)
    callerId = user.id

    const { data: profile, error: profileError } = await callerClient
      .from('profiles')
      .select('role, is_active')
      .eq('id', user.id)
      .single()
    if (profileError || !profile?.is_active) return jsonResponse({ error: 'An active account is required' }, 403)

    if (body.action === 'send_reminders') {
      if (profile.role !== 'admin') return jsonResponse({ error: 'Administrator access required' }, 403)
      const { data, error } = await callerClient.rpc('admin_create_maintenance_reminders', {
        p_days_before_due: body.days_before_due ?? 3,
        p_days_after_due: body.days_after_due ?? 7,
      })
      if (error) return jsonResponse({ error: error.message }, 400)
      return jsonResponse({ created: Number(data ?? 0) })
    }

    if (body.action !== 'test') return jsonResponse({ error: 'Unsupported notification action' }, 400)
  } else if (body.action !== undefined && body.action !== 'webhook') {
    return jsonResponse({ error: 'Service-role requests are reserved for notification delivery' }, 400)
  }

  webpush.setVapidDetails(`mailto:${subject.replace(/^mailto:/, '')}`, publicKey, privateKey)

  if (body.action === 'test' && callerId) {
    const { data: subscriptions, error: subscriptionsError } = await serviceClient
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('profile_id', callerId)
    if (subscriptionsError) return jsonResponse({ error: subscriptionsError.message }, 500)
    if (!subscriptions?.length) return jsonResponse({ error: 'Enable notifications on this device first' }, 409)

    const validSubscriptions = subscriptions.filter((subscription) => isAllowedPushEndpoint(subscription.endpoint))
    if (!validSubscriptions.length) return jsonResponse({ error: 'No supported push service endpoint was registered' }, 409)
    const results = await Promise.allSettled(validSubscriptions.map(async (subscription) => {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify({
          title: 'Notifications are working',
          body: 'This device can receive society account updates.',
          url: '/',
        }),
        { TTL: 60 },
      )
    }))
    const succeeded = results.filter((result) => result.status === 'fulfilled').length
    if (succeeded === 0) return jsonResponse({ error: 'The test notification could not be delivered' }, 502)
    return jsonResponse({ delivered: succeeded })
  }

  if (role !== 'service_role') return jsonResponse({ error: 'A notification webhook is required' }, 403)
  const notificationId = body.record?.id ?? body.notification_id
  if (!notificationId || typeof notificationId !== 'string') {
    return jsonResponse({ error: 'Notification record ID is required' }, 400)
  }

  const { data: notification, error: notificationError } = await serviceClient
    .from('notifications')
    .select('id, profile_id, title, body, data, type, push_status, push_attempted_at')
    .eq('id', notificationId)
    .maybeSingle()
  if (notificationError) return jsonResponse({ error: notificationError.message }, 500)
  if (!notification) return jsonResponse({ error: 'Notification was not found' }, 404)
  const staleProcessing = notification.push_status === 'processing'
    && notification.push_attempted_at
    && Date.parse(notification.push_attempted_at) < Date.now() - 5 * 60 * 1000
  if (notification.push_status !== 'pending' && !staleProcessing) {
    return jsonResponse({ status: notification.push_status })
  }

  const claimedAt = new Date().toISOString()
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data: claimed, error: claimError } = await serviceClient
    .from('notifications')
    .update({ push_status: 'processing', push_attempted_at: claimedAt })
    .eq('id', notification.id)
    .or(`push_status.eq.pending,and(push_status.eq.processing,push_attempted_at.lt.${staleBefore})`)
    .select('id')
    .maybeSingle()
  if (claimError) return jsonResponse({ error: claimError.message }, 500)
  if (!claimed) return jsonResponse({ status: 'processing' }, 202)

  const { data: preferences, error: preferencesError } = await serviceClient
    .from('notification_preferences')
    .select('push_enabled, maintenance_updates, payment_updates, society_updates, borrowing_updates, reminders')
    .eq('profile_id', notification.profile_id)
    .maybeSingle()
  if (preferencesError) {
    await serviceClient.from('notifications')
      .update({ push_status: 'failed', push_error: preferencesError.message, push_attempted_at: new Date().toISOString() })
      .eq('id', notification.id)
    return jsonResponse({ error: preferencesError.message }, 500)
  }

  const categoryEnabled = notification.type === 'maintenance_bill'
    ? preferences?.maintenance_updates
    : notification.type === 'payment_recorded'
      ? preferences?.payment_updates
      : notification.type === 'maintenance_reminder'
        ? preferences?.reminders
        : notification.type === 'society_borrowing_received' || notification.type === 'society_borrowing_repayment'
          ? preferences?.borrowing_updates
          : preferences?.society_updates

  const finish = async (status: 'sent' | 'skipped' | 'failed', pushError?: string) => {
    const { error } = await serviceClient
      .from('notifications')
      .update({ push_status: status, push_error: pushError?.slice(0, 500) ?? null })
      .eq('id', notification.id)
    if (error) throw new Error(`Could not update notification delivery status: ${error.message}`)
  }

  if (!preferences?.push_enabled || !categoryEnabled) {
    await finish('skipped')
    return jsonResponse({ status: 'skipped' })
  }

  const { data: subscriptions, error: subscriptionsError } = await serviceClient
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('profile_id', notification.profile_id)
  if (subscriptionsError) {
    await finish('failed', subscriptionsError.message)
    return jsonResponse({ error: subscriptionsError.message }, 500)
  }
  if (!subscriptions?.length) {
    await finish('skipped')
    return jsonResponse({ status: 'skipped' })
  }

  const validSubscriptions = subscriptions.filter((subscription) => isAllowedPushEndpoint(subscription.endpoint))
  const invalidSubscriptions = subscriptions.filter((subscription) => !isAllowedPushEndpoint(subscription.endpoint))
  if (invalidSubscriptions.length) {
    const { error: deleteError } = await serviceClient.from('push_subscriptions')
      .delete()
      .in('id', invalidSubscriptions.map((subscription) => subscription.id))
    if (deleteError) {
      await finish('failed', `Unsupported push subscription cleanup failed: ${deleteError.message}`)
      return jsonResponse({ error: deleteError.message }, 500)
    }
  }
  if (!validSubscriptions.length) {
    await finish('skipped', 'No supported push service endpoint was registered.')
    return jsonResponse({ status: 'skipped' })
  }

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: typeof notification.data?.url === 'string' ? notification.data.url : '/',
  })
  const results = await Promise.allSettled(validSubscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        { TTL: 60 },
      )
    } catch (sendError) {
      const statusCode = typeof sendError === 'object' && sendError !== null && 'statusCode' in sendError
        ? Number(sendError.statusCode)
        : 0
      if (statusCode === 404 || statusCode === 410) {
        const { error } = await serviceClient.from('push_subscriptions').delete().eq('id', subscription.id)
        if (error) throw new Error(`Expired subscription cleanup failed: ${error.message}`)
        return
      }
      throw sendError
    }
  }))

  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  const delivered = results.length - failures.length
  await finish(delivered > 0 ? 'sent' : 'failed', failures[0]?.reason instanceof Error ? failures[0].reason.message : undefined)
  if (delivered === 0) return jsonResponse({ error: 'Push delivery failed' }, 502)
  return jsonResponse({ status: 'sent', delivered, failed: failures.length })
})
