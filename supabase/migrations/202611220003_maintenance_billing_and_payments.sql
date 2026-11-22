create or replace function public.admin_create_accounting_month(p_month date)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_id uuid;
  v_opening_balance numeric(12,2) := 0;
  v_previous_month public.accounting_months%rowtype;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception 'Accounting month must be the first day of a month';
  end if;

  select id into v_month_id
  from public.accounting_months
  where month = p_month;
  if v_month_id is not null then
    return v_month_id;
  end if;

  select * into v_previous_month
  from public.accounting_months
  where month < p_month
  order by month desc
  limit 1
  for update;

  if exists (select 1 from public.accounting_months where month > p_month) then
    raise exception 'Accounting months must be created in chronological order';
  end if;

  if found then
    if v_previous_month.status <> 'closed' or v_previous_month.closing_balance is null then
      raise exception 'Close the previous accounting month before creating this month';
    end if;
    if v_previous_month.month <> (p_month - interval '1 month')::date then
      raise exception 'Create accounting months consecutively; the previous calendar month is missing';
    end if;
    v_opening_balance := v_previous_month.closing_balance;
  end if;

  insert into public.accounting_months (month, opening_balance, status)
  values (p_month, v_opening_balance, 'open')
  returning id into v_month_id;

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'accounting_month_created',
    'accounting_months',
    v_month_id,
    jsonb_build_object('month', p_month, 'opening_balance', v_opening_balance)
  );

  return v_month_id;
end;
$$;

create or replace function public.admin_generate_maintenance_charges(
  p_accounting_month_id uuid,
  p_due_date date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month public.accounting_months%rowtype;
  v_inserted_count integer;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_due_date is null then
    raise exception 'A due date is required';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id
  for update;

  if not found or v_month.status <> 'open' then
    raise exception 'Accounting month does not exist or is not open';
  end if;
  if p_due_date < v_month.month then
    raise exception 'Due date cannot be before the accounting month';
  end if;

  with inserted as (
    insert into public.maintenance_charges (
      flat_id,
      accounting_month_id,
      amount,
      due_date
    )
    select f.id, v_month.id, f.monthly_maintenance_amount, p_due_date
    from public.flats f
    where f.is_active
    on conflict (flat_id, accounting_month_id) do nothing
    returning id, flat_id, amount, due_date
  )
  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  select
    auth.uid(),
    'maintenance_charge_generated',
    'maintenance_charges',
    inserted.id,
    jsonb_build_object(
      'flat_id', inserted.flat_id,
      'accounting_month_id', v_month.id,
      'amount', inserted.amount,
      'due_date', inserted.due_date
    )
  from inserted;

  get diagnostics v_inserted_count = row_count;
  return v_inserted_count;
end;
$$;

create or replace function public.admin_record_maintenance_payment(
  p_flat_id uuid,
  p_accounting_month_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text,
  p_reference text,
  p_notes text,
  p_allocations jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month public.accounting_months%rowtype;
  v_payment_id uuid;
  v_allocated_total numeric(12,2) := 0;
  v_allocation record;
  v_outstanding numeric(12,2);
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_amount is null or p_amount <= 0 or p_payment_date is null
     or p_payment_method is null or btrim(p_payment_method) = '' then
    raise exception 'A positive payment amount, date, and method are required';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'Payment allocations must be a JSON array';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id
  for update;
  if not found or v_month.status <> 'open' then
    raise exception 'Payment month does not exist or is not open';
  end if;

  if not exists (
    select 1 from public.flats
    where id = p_flat_id and is_active
  ) then
    raise exception 'Active flat was not found';
  end if;

  for v_allocation in
    select allocation.charge_id, allocation.amount
    from jsonb_to_recordset(p_allocations) as allocation(charge_id uuid, amount numeric)
    order by allocation.charge_id
  loop
    if v_allocation.amount is null or v_allocation.amount <= 0 then
      raise exception 'Every allocation amount must be positive';
    end if;

    perform 1
    from public.maintenance_charges c
    where c.id = v_allocation.charge_id
      and c.flat_id = p_flat_id
    for update;
    if not found then
      raise exception 'Allocation charge must belong to this flat';
    end if;

    select c.amount - coalesce(sum(pa.allocated_amount), 0)
    into v_outstanding
    from public.maintenance_charges c
    left join public.payment_allocations pa on pa.maintenance_charge_id = c.id
    where c.id = v_allocation.charge_id
    group by c.id, c.amount;

    if v_allocation.amount > v_outstanding then
      raise exception 'Allocation exceeds the maintenance charge outstanding amount';
    end if;
    v_allocated_total := v_allocated_total + v_allocation.amount;
  end loop;

  if v_allocated_total > p_amount then
    raise exception 'Total allocations cannot exceed the payment amount';
  end if;

  insert into public.payments (
    flat_id,
    accounting_month_id,
    amount,
    payment_date,
    payment_method,
    reference,
    notes,
    recorded_by
  )
  values (
    p_flat_id,
    p_accounting_month_id,
    p_amount,
    p_payment_date,
    btrim(p_payment_method),
    nullif(btrim(p_reference), ''),
    nullif(btrim(p_notes), ''),
    auth.uid()
  )
  returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, maintenance_charge_id, allocated_amount)
  select v_payment_id, allocation.charge_id, allocation.amount
  from jsonb_to_recordset(p_allocations) as allocation(charge_id uuid, amount numeric);

  if v_allocated_total > 0 then
    insert into public.society_ledger (
      accounting_month_id, entry_type, direction, amount,
      source_table, source_id, description, created_by
    )
    values (
      p_accounting_month_id, 'maintenance_collection', 'in', v_allocated_total,
      'payments', v_payment_id, 'Allocated maintenance payment', auth.uid()
    );
  end if;

  if p_amount > v_allocated_total then
    insert into public.society_ledger (
      accounting_month_id, entry_type, direction, amount,
      source_table, source_id, description, created_by
    )
    values (
      p_accounting_month_id, 'user_maintenance_advance_received', 'in', p_amount - v_allocated_total,
      'payments', v_payment_id, 'Unallocated resident payment advance', auth.uid()
    );
  end if;

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'payment_recorded',
    'payments',
    v_payment_id,
    jsonb_build_object(
      'flat_id', p_flat_id,
      'accounting_month_id', p_accounting_month_id,
      'amount', p_amount,
      'allocated_amount', v_allocated_total,
      'unallocated_advance', p_amount - v_allocated_total,
      'payment_date', p_payment_date,
      'payment_method', btrim(p_payment_method)
    )
  );

  return v_payment_id;
end;
$$;

create or replace function public.admin_get_flat_open_charges(p_flat_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if not exists (select 1 from public.flats where id = p_flat_id) then
    raise exception 'Flat was not found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'flat_id', c.flat_id,
    'flat_number', f.flat_number,
    'accounting_month_id', c.accounting_month_id,
    'month', m.month,
    'amount', c.amount,
    'due_date', c.due_date,
    'paid', coalesce(a.allocated, 0),
    'outstanding', c.amount - coalesce(a.allocated, 0)
  ) order by m.month desc), '[]'::jsonb)
  into v_result
  from public.maintenance_charges c
  join public.accounting_months m on m.id = c.accounting_month_id
  join public.flats f on f.id = c.flat_id
  left join lateral (
    select sum(pa.allocated_amount) as allocated
    from public.payment_allocations pa
    where pa.maintenance_charge_id = c.id
  ) a on true
  where c.flat_id = p_flat_id
    and c.amount > coalesce(a.allocated, 0);

  return v_result;
end;
$$;

create or replace function public.get_maintenance_overview(p_accounting_month_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_flat_id uuid;
  v_month_id uuid;
  v_result jsonb;
begin
  select * into v_profile
  from public.profiles
  where id = auth.uid() and is_active;
  if not found then
    raise exception 'Active profile required';
  end if;

  select id into v_flat_id from public.flats
  where profile_id = auth.uid() and is_active;

  if p_accounting_month_id is not null then
    v_month_id := p_accounting_month_id;
  else
    select id into v_month_id
    from public.accounting_months
    order by (status = 'open') desc, month desc
    limit 1;
  end if;

  if v_month_id is not null and not exists (
    select 1 from public.accounting_months where id = v_month_id
  ) then
    raise exception 'Accounting month was not found';
  end if;

  select jsonb_build_object(
    'charges', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'flat_id', c.flat_id,
        'flat_number', f.flat_number,
        'accounting_month_id', c.accounting_month_id,
        'month', m.month,
        'amount', c.amount,
        'due_date', c.due_date,
        'paid', coalesce(a.allocated, 0),
        'outstanding', c.amount - coalesce(a.allocated, 0)
      ) order by f.flat_number)
      from public.maintenance_charges c
      join public.flats f on f.id = c.flat_id
      join public.accounting_months m on m.id = c.accounting_month_id
      left join lateral (
        select sum(pa.allocated_amount) as allocated
        from public.payment_allocations pa
        where pa.maintenance_charge_id = c.id
      ) a on true
      where c.accounting_month_id = v_month_id
        and (v_profile.role = 'admin' or c.flat_id = v_flat_id)
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'flat_id', p.flat_id,
        'flat_number', f.flat_number,
        'amount', p.amount,
        'payment_date', p.payment_date,
        'payment_method', p.payment_method,
        'reference', p.reference,
        'notes', p.notes,
        'allocated', coalesce(a.allocated, 0),
        'credit', p.amount - coalesce(a.allocated, 0)
      ) order by p.payment_date desc, p.created_at desc)
      from public.payments p
      join public.flats f on f.id = p.flat_id
      left join lateral (
        select sum(pa.allocated_amount) as allocated
        from public.payment_allocations pa
        where pa.payment_id = p.id
      ) a on true
      where p.accounting_month_id = v_month_id
        and (v_profile.role = 'admin' or p.flat_id = v_flat_id)
    ), '[]'::jsonb)
  )
  into v_result;

  return coalesce(v_result, jsonb_build_object('charges', '[]'::jsonb, 'payments', '[]'::jsonb));
end;
$$;

revoke all on function public.admin_create_accounting_month(date) from public, anon;
revoke all on function public.admin_generate_maintenance_charges(uuid, date) from public, anon;
revoke all on function public.admin_record_maintenance_payment(uuid, uuid, numeric, date, text, text, text, jsonb) from public, anon;
revoke all on function public.admin_get_flat_open_charges(uuid) from public, anon;
revoke all on function public.get_maintenance_overview(uuid) from public, anon;
grant execute on function public.admin_create_accounting_month(date) to authenticated;
grant execute on function public.admin_generate_maintenance_charges(uuid, date) to authenticated;
grant execute on function public.admin_record_maintenance_payment(uuid, uuid, numeric, date, text, text, text, jsonb) to authenticated;
grant execute on function public.admin_get_flat_open_charges(uuid) to authenticated;
grant execute on function public.get_maintenance_overview(uuid) to authenticated;
