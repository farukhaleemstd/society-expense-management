import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const authorization = request.headers.get('Authorization')
  if (!url || !anonKey || !serviceRoleKey || !authorization) {
    return new Response(JSON.stringify({ error: 'Server configuration or authorization is missing' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const callerClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  })
  const { data: { user }, error: userError } = await callerClient.auth.getUser()
  if (userError || !user) {
    return new Response(JSON.stringify({ error: 'A valid signed-in administrator is required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { data: callerProfile, error: profileError } = await callerClient
    .from('profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (profileError || !callerProfile || callerProfile.role !== 'admin' || !callerProfile.is_active) {
    return new Response(JSON.stringify({ error: 'Administrator access required' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let body: {
    email?: string
    password?: string
    fullName?: string
    phone?: string
    flatNumber?: string
    floor?: string
    monthlyMaintenanceAmount?: number
  }
  try {
    body = await request.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Request body must be valid JSON' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ error: 'Request body must be a JSON object' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  if (
    !body.email?.trim()
    || !body.password
    || body.password.length < 8
    || !body.fullName?.trim()
    || !body.flatNumber?.trim()
    || typeof body.monthlyMaintenanceAmount !== 'number'
    || !Number.isFinite(body.monthlyMaintenanceAmount)
    || body.monthlyMaintenanceAmount < 0
  ) {
    return new Response(JSON.stringify({ error: 'Valid email, a password of at least 8 characters, name, flat number, and non-negative maintenance are required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const adminClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: created, error: createUserError } = await adminClient.auth.admin.createUser({
    email: body.email.trim(),
    password: body.password,
    email_confirm: true,
  })
  if (createUserError || !created.user) {
    return new Response(JSON.stringify({ error: createUserError?.message ?? 'Could not create resident account' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { error: createError } = await callerClient.rpc('admin_create_resident', {
    p_profile_id: created.user.id,
    p_full_name: body.fullName.trim(),
    p_phone: body.phone?.trim() || null,
    p_flat_number: body.flatNumber.trim(),
    p_floor: body.floor?.trim() || null,
    p_monthly_maintenance_amount: body.monthlyMaintenanceAmount,
  })

  if (createError) {
    const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id)
    const message = cleanupError
      ? `${createError.message}. Account cleanup also failed: ${cleanupError.message}`
      : createError.message
    return new Response(JSON.stringify({ error: message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ userId: created.user.id }), {
    status: 201,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
