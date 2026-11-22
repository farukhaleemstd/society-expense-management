grant insert, update, delete on public.profiles, public.flats to authenticated;

create or replace function public.admin_create_resident(
  p_profile_id uuid,
  p_full_name text,
  p_phone text,
  p_flat_number text,
  p_floor text,
  p_monthly_maintenance_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;

  if p_full_name is null or btrim(p_full_name) = ''
     or p_flat_number is null or btrim(p_flat_number) = ''
     or p_monthly_maintenance_amount is null or p_monthly_maintenance_amount < 0 then
    raise exception 'Name, flat number, and a non-negative maintenance amount are required';
  end if;

  insert into public.profiles (id, full_name, phone, role, is_active)
  values (p_profile_id, btrim(p_full_name), nullif(btrim(p_phone), ''), 'resident', true);

  insert into public.flats (
    flat_number,
    floor,
    profile_id,
    monthly_maintenance_amount,
    is_active
  )
  values (
    btrim(p_flat_number),
    nullif(btrim(p_floor), ''),
    p_profile_id,
    p_monthly_maintenance_amount,
    true
  );
end;
$$;

create or replace function public.admin_update_resident(
  p_profile_id uuid,
  p_full_name text,
  p_phone text,
  p_is_active boolean,
  p_flat_id uuid,
  p_flat_number text,
  p_floor text,
  p_monthly_maintenance_amount numeric,
  p_flat_is_active boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;

  if p_full_name is null or btrim(p_full_name) = ''
     or p_flat_number is null or btrim(p_flat_number) = ''
     or p_monthly_maintenance_amount is null or p_monthly_maintenance_amount < 0 then
    raise exception 'Name, flat number, and a non-negative maintenance amount are required';
  end if;

  update public.profiles
  set full_name = btrim(p_full_name),
      phone = nullif(btrim(p_phone), ''),
      is_active = p_is_active
  where id = p_profile_id and role = 'resident';

  if not found then
    raise exception 'Resident profile was not found';
  end if;

  if p_flat_id is null then
    insert into public.flats (
      flat_number,
      floor,
      profile_id,
      monthly_maintenance_amount,
      is_active
    )
    values (
      btrim(p_flat_number),
      nullif(btrim(p_floor), ''),
      p_profile_id,
      p_monthly_maintenance_amount,
      p_flat_is_active
    );
  else
    update public.flats
    set flat_number = btrim(p_flat_number),
        floor = nullif(btrim(p_floor), ''),
        monthly_maintenance_amount = p_monthly_maintenance_amount,
        is_active = p_flat_is_active
    where id = p_flat_id and profile_id = p_profile_id;

    if not found then
      raise exception 'Assigned flat was not found';
    end if;
  end if;
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
  select role into v_role from public.profiles
  where id = auth.uid() and is_active;

  if v_role is null then
    raise exception 'Active profile required';
  end if;

  select *
  into v_month
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
  where (v_role = 'admin' or f.profile_id = auth.uid());

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
        or l.entry_type in ('maintenance_collection', 'user_loan_received', 'user_loan_repayment', 'expense')
      );

    select coalesce(sum(case when l.direction = 'in' then l.amount else -l.amount end), 0)
    into v_balance
    from public.society_ledger l
    where l.accounting_month_id = v_month.id;

    v_balance := coalesce(v_month.opening_balance, 0) + v_balance;
  end if;

  if v_role = 'resident' then
    select coalesce(sum(loan.amount), 0) - coalesce((
      select sum(repayment.amount)
      from public.user_loan_repayments repayment
      join public.user_loans repayment_loan on repayment_loan.id = repayment.user_loan_id
      where repayment_loan.profile_id = auth.uid()
    ), 0)
    into v_society_owed
    from public.user_loans loan
    where loan.profile_id = auth.uid();
  else
    select coalesce(sum(loan.amount), 0) - coalesce((
      select sum(r.amount)
      from public.user_loan_repayments r
    ), 0)
    into v_society_owed
    from public.user_loans loan;
  end if;

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

grant execute on function public.admin_create_resident(uuid, text, text, text, text, numeric) to authenticated;
grant execute on function public.admin_update_resident(uuid, text, text, boolean, uuid, text, text, numeric, boolean) to authenticated;
grant execute on function public.get_dashboard_summary() to authenticated;
