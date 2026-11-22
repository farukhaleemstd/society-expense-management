drop policy if exists "authenticated read loan public summary" on public.user_loans;
drop policy if exists "authenticated read repayment public summary" on public.user_loan_repayments;

update public.society_ledger l
set amount = p.amount,
    description = 'Maintenance payment received'
from public.payments p
where l.source_table = 'payments'
  and l.source_id = p.id
  and l.entry_type = 'maintenance_collection';

delete from public.society_ledger advance_entry
using public.society_ledger collection_entry
where advance_entry.source_table = 'payments'
  and advance_entry.entry_type = 'user_maintenance_advance_received'
  and collection_entry.source_table = advance_entry.source_table
  and collection_entry.source_id = advance_entry.source_id
  and collection_entry.entry_type = 'maintenance_collection';

update public.society_ledger l
set entry_type = 'maintenance_collection',
    amount = p.amount,
    description = 'Maintenance payment received'
from public.payments p
where l.source_table = 'payments'
  and l.source_id = p.id
  and l.entry_type = 'user_maintenance_advance_received';

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
  if p_payment_date < v_month.month
     or p_payment_date >= (v_month.month + interval '1 month')::date then
    raise exception 'Payment date must fall within the selected accounting month';
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
    flat_id, accounting_month_id, amount, payment_date,
    payment_method, reference, notes, recorded_by
  )
  values (
    p_flat_id, p_accounting_month_id, p_amount, p_payment_date,
    btrim(p_payment_method), nullif(btrim(p_reference), ''),
    nullif(btrim(p_notes), ''), auth.uid()
  )
  returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, maintenance_charge_id, allocated_amount)
  select v_payment_id, allocation.charge_id, allocation.amount
  from jsonb_to_recordset(p_allocations) as allocation(charge_id uuid, amount numeric);

  insert into public.society_ledger (
    accounting_month_id, entry_type, direction, amount,
    source_table, source_id, description, created_by
  )
  values (
    p_accounting_month_id,
    'maintenance_collection',
    'in',
    p_amount,
    'payments',
    v_payment_id,
    format(
      'Maintenance payment received; allocated %s; advance %s',
      v_allocated_total,
      p_amount - v_allocated_total
    ),
    auth.uid()
  );

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

create or replace function public.admin_record_user_loan(
  p_profile_id uuid,
  p_accounting_month_id uuid,
  p_amount numeric,
  p_received_date date,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month public.accounting_months%rowtype;
  v_loan_id uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_amount is null or p_amount <= 0 or p_received_date is null then
    raise exception 'A positive loan amount and date are required';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_profile_id and role = 'resident' and is_active
  ) then
    raise exception 'An active resident must be selected';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id
  for update;
  if not found or v_month.status <> 'open' then
    raise exception 'Loan month does not exist or is not open';
  end if;
  if p_received_date < v_month.month
     or p_received_date >= (v_month.month + interval '1 month')::date then
    raise exception 'Loan date must fall within the selected accounting month';
  end if;

  insert into public.user_loans (
    profile_id, accounting_month_id, amount, received_date, notes, recorded_by
  )
  values (
    p_profile_id, p_accounting_month_id, p_amount, p_received_date,
    nullif(btrim(p_notes), ''), auth.uid()
  )
  returning id into v_loan_id;

  insert into public.society_ledger (
    accounting_month_id, entry_type, direction, amount,
    source_table, source_id, description, created_by
  )
  values (
    p_accounting_month_id, 'user_loan_received', 'out', p_amount,
    'user_loans', v_loan_id, 'Resident loan issued', auth.uid()
  );

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'user_loan_recorded',
    'user_loans',
    v_loan_id,
    jsonb_build_object(
      'profile_id', p_profile_id,
      'accounting_month_id', p_accounting_month_id,
      'amount', p_amount,
      'received_date', p_received_date
    )
  );

  return v_loan_id;
end;
$$;

create or replace function public.admin_record_user_loan_repayment(
  p_user_loan_id uuid,
  p_accounting_month_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month public.accounting_months%rowtype;
  v_loan public.user_loans%rowtype;
  v_repayment_id uuid;
  v_outstanding numeric(12,2);
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_amount is null or p_amount <= 0 or p_payment_date is null then
    raise exception 'A positive repayment amount and date are required';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id
  for update;
  if not found or v_month.status <> 'open' then
    raise exception 'Repayment month does not exist or is not open';
  end if;
  if p_payment_date < v_month.month
     or p_payment_date >= (v_month.month + interval '1 month')::date then
    raise exception 'Repayment date must fall within the selected accounting month';
  end if;

  select * into v_loan
  from public.user_loans
  where id = p_user_loan_id
  for update;
  if not found then
    raise exception 'Resident loan was not found';
  end if;

  select v_loan.amount - coalesce(sum(r.amount), 0)
  into v_outstanding
  from public.user_loan_repayments r
  where r.user_loan_id = v_loan.id;
  if p_amount > v_outstanding then
    raise exception 'Repayment cannot exceed the loan outstanding amount';
  end if;

  insert into public.user_loan_repayments (
    user_loan_id, accounting_month_id, amount, payment_date, notes, recorded_by
  )
  values (
    v_loan.id, p_accounting_month_id, p_amount, p_payment_date,
    nullif(btrim(p_notes), ''), auth.uid()
  )
  returning id into v_repayment_id;

  insert into public.society_ledger (
    accounting_month_id, entry_type, direction, amount,
    source_table, source_id, description, created_by
  )
  values (
    p_accounting_month_id, 'user_loan_repayment', 'in', p_amount,
    'user_loan_repayments', v_repayment_id, 'Resident loan repayment', auth.uid()
  );

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'user_loan_repayment_recorded',
    'user_loan_repayments',
    v_repayment_id,
    jsonb_build_object(
      'user_loan_id', v_loan.id,
      'profile_id', v_loan.profile_id,
      'accounting_month_id', p_accounting_month_id,
      'amount', p_amount,
      'payment_date', p_payment_date
    )
  );

  return v_repayment_id;
end;
$$;

create or replace function public.get_admin_loan_overview()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loans jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', l.id,
      'profile_id', l.profile_id,
      'resident_name', p.full_name,
      'flat_number', f.flat_number,
      'accounting_month_id', l.accounting_month_id,
      'month', m.month,
      'amount', l.amount,
      'received_date', l.received_date,
      'notes', l.notes,
      'repaid', coalesce(r.total_repaid, 0),
      'outstanding', l.amount - coalesce(r.total_repaid, 0)
    ) order by l.received_date desc, l.created_at desc
  ), '[]'::jsonb)
  into v_loans
  from public.user_loans l
  join public.profiles p on p.id = l.profile_id
  left join public.flats f on f.profile_id = p.id
  join public.accounting_months m on m.id = l.accounting_month_id
  left join lateral (
    select sum(repayment.amount) as total_repaid
    from public.user_loan_repayments repayment
    where repayment.user_loan_id = l.id
  ) r on true;

  return v_loans;
end;
$$;

create or replace function public.get_account_statement(p_accounting_month_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_month public.accounting_months%rowtype;
  v_flat_id uuid;
  v_opening_balance numeric(12,2);
  v_closing_balance numeric(12,2);
  v_entries jsonb;
begin
  select * into v_profile
  from public.profiles
  where id = auth.uid() and is_active;
  if not found then
    raise exception 'Active profile required';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id;
  if not found then
    raise exception 'Accounting month was not found';
  end if;

  if v_profile.role = 'admin' then
    v_opening_balance := v_month.opening_balance;

    with ordered as (
      select
        l.id,
        l.created_at::date as entry_date,
        l.created_at,
        l.entry_type,
        l.direction::text as direction,
        l.amount,
        l.description,
        sum(case when l.direction = 'in' then l.amount else -l.amount end)
          over (order by l.created_at, l.id) as month_change
      from public.society_ledger l
      where l.accounting_month_id = v_month.id
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'entry_date', entry_date,
        'entry_type', entry_type,
        'direction', direction,
        'amount', amount,
        'description', description,
        'balance_after', v_opening_balance + month_change
      ) order by created_at, id), '[]'::jsonb),
      v_opening_balance + coalesce(sum(
        case when direction = 'in' then amount else -amount end
      ), 0)
    into v_entries, v_closing_balance
    from ordered;
  else
    select id into v_flat_id
    from public.flats
    where profile_id = auth.uid() and is_active;

    with all_movements as (
      select m.month, c.amount as change
      from public.maintenance_charges c
      join public.accounting_months m on m.id = c.accounting_month_id
      where c.flat_id = v_flat_id
      union all
      select m.month, -p.amount
      from public.payments p
      join public.accounting_months m on m.id = p.accounting_month_id
      where p.flat_id = v_flat_id
      union all
      select m.month, l.amount
      from public.user_loans l
      join public.accounting_months m on m.id = l.accounting_month_id
      where l.profile_id = auth.uid()
      union all
      select m.month, -r.amount
      from public.user_loan_repayments r
      join public.user_loans l on l.id = r.user_loan_id
      join public.accounting_months m on m.id = r.accounting_month_id
      where l.profile_id = auth.uid()
    )
    select coalesce(sum(change), 0)
    into v_opening_balance
    from all_movements
    where month < v_month.month;

    with movements as (
      select
        c.id,
        m.month as month_sort,
        c.created_at,
        m.month as entry_date,
        'maintenance_charge'::text as entry_type,
        'in'::text as direction,
        c.amount,
        c.amount as change,
        'Maintenance charge'::text as description
      from public.maintenance_charges c
      join public.accounting_months m on m.id = c.accounting_month_id
      where c.flat_id = v_flat_id and m.id = v_month.id
      union all
      select
        p.id,
        m.month,
        p.created_at,
        p.payment_date,
        'maintenance_payment',
        'out',
        p.amount,
        -p.amount,
        'Maintenance payment' || case when p.reference is null then '' else ' · ' || p.reference end
      from public.payments p
      join public.accounting_months m on m.id = p.accounting_month_id
      where p.flat_id = v_flat_id and m.id = v_month.id
      union all
      select
        l.id,
        m.month,
        l.created_at,
        l.received_date,
        'user_loan_received',
        'in',
        l.amount,
        l.amount,
        'Society loan received'
      from public.user_loans l
      join public.accounting_months m on m.id = l.accounting_month_id
      where l.profile_id = auth.uid() and m.id = v_month.id
      union all
      select
        r.id,
        m.month,
        r.created_at,
        r.payment_date,
        'user_loan_repayment',
        'out',
        r.amount,
        -r.amount,
        'Loan repayment'
      from public.user_loan_repayments r
      join public.user_loans l on l.id = r.user_loan_id
      join public.accounting_months m on m.id = r.accounting_month_id
      where l.profile_id = auth.uid() and m.id = v_month.id
    ),
    ordered as (
      select
        *,
        sum(change) over (order by entry_date, created_at, id) as month_change
      from movements
    )
    select
      coalesce(jsonb_agg(jsonb_build_object(
        'id', id,
        'entry_date', entry_date,
        'entry_type', entry_type,
        'direction', direction,
        'amount', amount,
        'description', description,
        'balance_after', v_opening_balance + month_change
      ) order by entry_date, created_at, id), '[]'::jsonb),
      v_opening_balance + coalesce(sum(change), 0)
    into v_entries, v_closing_balance
    from ordered;
  end if;

  return jsonb_build_object(
    'month', v_month.month,
    'month_status', v_month.status,
    'opening_balance', v_opening_balance,
    'closing_balance', v_closing_balance,
    'entries', coalesce(v_entries, '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_record_user_loan(uuid, uuid, numeric, date, text) from public, anon;
revoke all on function public.admin_record_user_loan_repayment(uuid, uuid, numeric, date, text) from public, anon;
revoke all on function public.get_admin_loan_overview() from public, anon;
revoke all on function public.get_account_statement(uuid) from public, anon;
revoke all on function public.admin_record_maintenance_payment(uuid, uuid, numeric, date, text, text, text, jsonb) from public, anon;

grant execute on function public.admin_record_user_loan(uuid, uuid, numeric, date, text) to authenticated;
grant execute on function public.admin_record_user_loan_repayment(uuid, uuid, numeric, date, text) to authenticated;
grant execute on function public.get_admin_loan_overview() to authenticated;
grant execute on function public.get_account_statement(uuid) to authenticated;
grant execute on function public.admin_record_maintenance_payment(uuid, uuid, numeric, date, text, text, text, jsonb) to authenticated;
