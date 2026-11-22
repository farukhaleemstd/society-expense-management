create table if not exists public.society_borrowings (
  id uuid primary key default gen_random_uuid(),
  lender_profile_id uuid not null references public.profiles(id),
  accounting_month_id uuid not null references public.accounting_months(id),
  amount numeric(12,2) not null check (amount > 0),
  received_date date not null,
  notes text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.society_borrowing_repayments (
  id uuid primary key default gen_random_uuid(),
  society_borrowing_id uuid not null references public.society_borrowings(id),
  accounting_month_id uuid not null references public.accounting_months(id),
  amount numeric(12,2) not null check (amount > 0),
  payment_date date not null,
  notes text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists society_borrowings_lender_idx
  on public.society_borrowings(lender_profile_id);
create index if not exists society_borrowings_month_idx
  on public.society_borrowings(accounting_month_id);
create index if not exists society_borrowing_repayments_loan_idx
  on public.society_borrowing_repayments(society_borrowing_id);
create index if not exists society_borrowing_repayments_month_idx
  on public.society_borrowing_repayments(accounting_month_id);

alter table public.society_borrowings enable row level security;
alter table public.society_borrowing_repayments enable row level security;
grant select on public.society_borrowings, public.society_borrowing_repayments to authenticated;

drop policy if exists "users read own society borrowings" on public.society_borrowings;
create policy "users read own society borrowings"
on public.society_borrowings
for select to authenticated
using (lender_profile_id = auth.uid() or public.is_active_admin());

drop policy if exists "users read own society borrowing repayments" on public.society_borrowing_repayments;
create policy "users read own society borrowing repayments"
on public.society_borrowing_repayments
for select to authenticated
using (
  exists (
    select 1
    from public.society_borrowings b
    where b.id = society_borrowing_id
      and b.lender_profile_id = auth.uid()
  )
  or public.is_active_admin()
);

drop policy if exists "residents read own loans" on public.user_loans;
drop policy if exists "authenticated read loan public summary" on public.user_loans;
drop policy if exists "admins manage loans" on public.user_loans;
drop policy if exists "admins read legacy resident loans" on public.user_loans;
create policy "admins read legacy resident loans"
on public.user_loans
for select to authenticated
using (public.is_active_admin());

drop policy if exists "residents read own loan repayments" on public.user_loan_repayments;
drop policy if exists "authenticated read repayment public summary" on public.user_loan_repayments;
drop policy if exists "admins manage loan repayments" on public.user_loan_repayments;
drop policy if exists "admins read legacy resident loan repayments" on public.user_loan_repayments;
create policy "admins read legacy resident loan repayments"
on public.user_loan_repayments
for select to authenticated
using (public.is_active_admin());

do $$
begin
  if to_regprocedure('public.admin_record_user_loan(uuid,uuid,numeric,date,text)') is not null then
    execute 'revoke all on function public.admin_record_user_loan(uuid, uuid, numeric, date, text) from public, anon, authenticated';
  end if;
  if to_regprocedure('public.admin_record_user_loan_repayment(uuid,uuid,numeric,date,text)') is not null then
    execute 'revoke all on function public.admin_record_user_loan_repayment(uuid, uuid, numeric, date, text) from public, anon, authenticated';
  end if;
  if to_regprocedure('public.get_admin_loan_overview()') is not null then
    execute 'revoke all on function public.get_admin_loan_overview() from public, anon, authenticated';
  end if;
end;
$$;

create or replace function public.admin_record_society_borrowing(
  p_lender_profile_id uuid,
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
  v_borrowing_id uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_amount is null or p_amount <= 0 or p_received_date is null then
    raise exception 'A positive borrowing amount and received date are required';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_lender_profile_id and role = 'resident' and is_active
  ) then
    raise exception 'An active individual must be selected as the lender';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id
  for update;
  if not found or v_month.status <> 'open' then
    raise exception 'Borrowing month does not exist or is not open';
  end if;
  if p_received_date < v_month.month
     or p_received_date >= (v_month.month + interval '1 month')::date then
    raise exception 'Funds received date must fall within the selected accounting month';
  end if;

  insert into public.society_borrowings (
    lender_profile_id, accounting_month_id, amount, received_date, notes, recorded_by
  )
  values (
    p_lender_profile_id, p_accounting_month_id, p_amount, p_received_date,
    nullif(btrim(p_notes), ''), auth.uid()
  )
  returning id into v_borrowing_id;

  insert into public.society_ledger (
    accounting_month_id, entry_type, direction, amount,
    source_table, source_id, description, created_by
  )
  values (
    p_accounting_month_id,
    'society_borrowing_received',
    'in',
    p_amount,
    'society_borrowings',
    v_borrowing_id,
    'Funds borrowed from an individual',
    auth.uid()
  );

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'society_borrowing_recorded',
    'society_borrowings',
    v_borrowing_id,
    jsonb_build_object(
      'lender_profile_id', p_lender_profile_id,
      'accounting_month_id', p_accounting_month_id,
      'amount', p_amount,
      'received_date', p_received_date
    )
  );

  return v_borrowing_id;
end;
$$;

create or replace function public.admin_record_society_borrowing_repayment(
  p_society_borrowing_id uuid,
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
  v_borrowing public.society_borrowings%rowtype;
  v_repayment_id uuid;
  v_outstanding numeric(12,2);
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_amount is null or p_amount <= 0 or p_payment_date is null then
    raise exception 'A positive repayment amount and payment date are required';
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

  select * into v_borrowing
  from public.society_borrowings
  where id = p_society_borrowing_id
  for update;
  if not found then
    raise exception 'Society borrowing was not found';
  end if;

  select v_borrowing.amount - coalesce(sum(r.amount), 0)
  into v_outstanding
  from public.society_borrowing_repayments r
  where r.society_borrowing_id = v_borrowing.id;
  if p_amount > v_outstanding then
    raise exception 'Repayment cannot exceed the amount the society owes this lender';
  end if;

  insert into public.society_borrowing_repayments (
    society_borrowing_id, accounting_month_id, amount, payment_date, notes, recorded_by
  )
  values (
    v_borrowing.id, p_accounting_month_id, p_amount, p_payment_date,
    nullif(btrim(p_notes), ''), auth.uid()
  )
  returning id into v_repayment_id;

  insert into public.society_ledger (
    accounting_month_id, entry_type, direction, amount,
    source_table, source_id, description, created_by
  )
  values (
    p_accounting_month_id,
    'society_borrowing_repayment',
    'out',
    p_amount,
    'society_borrowing_repayments',
    v_repayment_id,
    'Repayment to an individual lender',
    auth.uid()
  );

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'society_borrowing_repayment_recorded',
    'society_borrowing_repayments',
    v_repayment_id,
    jsonb_build_object(
      'society_borrowing_id', v_borrowing.id,
      'lender_profile_id', v_borrowing.lender_profile_id,
      'accounting_month_id', p_accounting_month_id,
      'amount', p_amount,
      'payment_date', p_payment_date
    )
  );

  return v_repayment_id;
end;
$$;

create or replace function public.get_admin_society_borrowings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_borrowings jsonb;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', b.id,
      'lender_profile_id', b.lender_profile_id,
      'lender_name', p.full_name,
      'flat_number', f.flat_number,
      'accounting_month_id', b.accounting_month_id,
      'month', m.month,
      'amount', b.amount,
      'received_date', b.received_date,
      'notes', b.notes,
      'repaid', coalesce(r.total_repaid, 0),
      'outstanding', b.amount - coalesce(r.total_repaid, 0)
    ) order by b.received_date desc, b.created_at desc
  ), '[]'::jsonb)
  into v_borrowings
  from public.society_borrowings b
  join public.profiles p on p.id = b.lender_profile_id
  left join public.flats f on f.profile_id = p.id
  join public.accounting_months m on m.id = b.accounting_month_id
  left join lateral (
    select sum(repayment.amount) as total_repaid
    from public.society_borrowing_repayments repayment
    where repayment.society_borrowing_id = b.id
  ) r on true;

  return v_borrowings;
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
      union all
      select m.month, -b.amount
      from public.society_borrowings b
      join public.accounting_months m on m.id = b.accounting_month_id
      where b.lender_profile_id = auth.uid()
      union all
      select m.month, r.amount
      from public.society_borrowing_repayments r
      join public.society_borrowings b on b.id = r.society_borrowing_id
      join public.accounting_months m on m.id = r.accounting_month_id
      where b.lender_profile_id = auth.uid()
    )
    select coalesce(sum(change), 0)
    into v_opening_balance
    from all_movements
    where month < v_month.month;

    with movements as (
      select
        c.id,
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
        l.created_at,
        l.received_date,
        'legacy_society_loan_to_resident',
        'in',
        l.amount,
        l.amount,
        'Legacy: society loan to resident'
      from public.user_loans l
      join public.accounting_months m on m.id = l.accounting_month_id
      where l.profile_id = auth.uid() and m.id = v_month.id
      union all
      select
        r.id,
        r.created_at,
        r.payment_date,
        'legacy_resident_loan_repayment',
        'out',
        r.amount,
        -r.amount,
        'Legacy: repayment to society'
      from public.user_loan_repayments r
      join public.user_loans l on l.id = r.user_loan_id
      join public.accounting_months m on m.id = r.accounting_month_id
      where l.profile_id = auth.uid() and m.id = v_month.id
      union all
      select
        b.id,
        b.created_at,
        b.received_date,
        'society_borrowing',
        'out',
        b.amount,
        -b.amount,
        'Funds lent to society'
      from public.society_borrowings b
      join public.accounting_months m on m.id = b.accounting_month_id
      where b.lender_profile_id = auth.uid() and m.id = v_month.id
      union all
      select
        r.id,
        r.created_at,
        r.payment_date,
        'society_borrowing_repayment',
        'in',
        r.amount,
        r.amount,
        'Repayment received from society'
      from public.society_borrowing_repayments r
      join public.society_borrowings b on b.id = r.society_borrowing_id
      join public.accounting_months m on m.id = r.accounting_month_id
      where b.lender_profile_id = auth.uid() and m.id = v_month.id
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

create or replace function public.get_dashboard_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.user_role;
  v_flat_id uuid;
  v_flat_number text;
  v_maintenance numeric(12,2);
  v_month public.accounting_months%rowtype;
  v_billed numeric(12,2) := 0;
  v_collected numeric(12,2) := 0;
  v_expenses numeric(12,2) := 0;
  v_balance numeric(12,2) := 0;
  v_society_owed numeric(12,2) := 0;
  v_unpaid numeric(12,2) := 0;
  v_current_bill numeric(12,2) := 0;
  v_month_billed numeric(12,2) := 0;
begin
  select role into v_role
  from public.profiles
  where id = auth.uid() and is_active;
  if v_role is null then
    raise exception 'Active profile required';
  end if;

  select * into v_month
  from public.accounting_months
  order by (status = 'open') desc, month desc
  limit 1;

  select id, flat_number, monthly_maintenance_amount
  into v_flat_id, v_flat_number, v_maintenance
  from public.flats
  where profile_id = auth.uid() and is_active;

  select coalesce(sum(c.amount), 0)
  into v_billed
  from public.maintenance_charges c
  join public.flats f on f.id = c.flat_id
  where v_role = 'admin' or f.profile_id = auth.uid();

  select coalesce(sum(c.amount - coalesce(a.allocated, 0)), 0)
  into v_unpaid
  from public.maintenance_charges c
  join public.flats f on f.id = c.flat_id
  left join lateral (
    select sum(pa.allocated_amount) as allocated
    from public.payment_allocations pa
    where pa.maintenance_charge_id = c.id
  ) a on true
  where v_role = 'admin' or f.profile_id = auth.uid();

  if v_month.id is not null then
    select coalesce(sum(c.amount), 0)
    into v_month_billed
    from public.maintenance_charges c
    where c.accounting_month_id = v_month.id
      and (v_role = 'admin' or c.flat_id = v_flat_id);

    select coalesce(sum(l.amount) filter (where l.entry_type = 'maintenance_collection'), 0),
           coalesce(sum(l.amount) filter (where l.entry_type = 'expense'), 0)
    into v_collected, v_expenses
    from public.society_ledger l
    where l.accounting_month_id = v_month.id
      and (
        v_role = 'admin'
        or l.entry_type in ('maintenance_collection', 'society_borrowing_received', 'society_borrowing_repayment', 'expense')
      );

    select coalesce(sum(case when l.direction = 'in' then l.amount else -l.amount end), 0)
    into v_balance
    from public.society_ledger l
    where l.accounting_month_id = v_month.id;
    v_balance := coalesce(v_month.opening_balance, 0) + v_balance;
  end if;

  select coalesce(sum(b.amount - coalesce(r.total_repaid, 0)), 0)
  into v_society_owed
  from public.society_borrowings b
  left join lateral (
    select sum(repayment.amount) as total_repaid
    from public.society_borrowing_repayments repayment
    where repayment.society_borrowing_id = b.id
  ) r on true
  where v_role = 'admin' or b.lender_profile_id = auth.uid();

  if v_month.id is not null and v_flat_id is not null then
    select coalesce(sum(c.amount), 0)
    into v_current_bill
    from public.maintenance_charges c
    where c.accounting_month_id = v_month.id and c.flat_id = v_flat_id;
  end if;

  return jsonb_build_object(
    'role', v_role,
    'month', v_month.month,
    'month_status', v_month.status,
    'opening_balance', v_month.opening_balance,
    'flat_number', v_flat_number,
    'monthly_maintenance_amount', v_maintenance,
    'current_bill', v_current_bill,
    'unpaid_maintenance', v_unpaid,
    'total_billed', v_billed,
    'month_billed', v_month_billed,
    'collected', v_collected,
    'expenses', v_expenses,
    'society_balance', case when v_month.id is null then null else v_balance end,
    'society_owed', v_society_owed
  );
end;
$$;

revoke all on function public.admin_record_society_borrowing(uuid, uuid, numeric, date, text) from public, anon, authenticated;
revoke all on function public.admin_record_society_borrowing_repayment(uuid, uuid, numeric, date, text) from public, anon, authenticated;
revoke all on function public.get_admin_society_borrowings() from public, anon, authenticated;
revoke all on function public.get_account_statement(uuid) from public, anon, authenticated;
revoke all on function public.get_dashboard_summary() from public, anon, authenticated;

grant execute on function public.admin_record_society_borrowing(uuid, uuid, numeric, date, text) to authenticated;
grant execute on function public.admin_record_society_borrowing_repayment(uuid, uuid, numeric, date, text) to authenticated;
grant execute on function public.get_admin_society_borrowings() to authenticated;
grant execute on function public.get_account_statement(uuid) to authenticated;
grant execute on function public.get_dashboard_summary() to authenticated;
