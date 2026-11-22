create or replace function public.get_month_reconciliation(p_accounting_month_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month public.accounting_months%rowtype;
  v_active_flats integer;
  v_billed_flats integer;
  v_missing_flat_bills integer;
  v_total_billed numeric(12,2) := 0;
  v_total_collected numeric(12,2) := 0;
  v_total_outstanding numeric(12,2) := 0;
  v_other_income numeric(12,2) := 0;
  v_total_expenses numeric(12,2) := 0;
  v_borrowings_received numeric(12,2) := 0;
  v_borrowing_repayments numeric(12,2) := 0;
  v_closing_balance numeric(12,2) := 0;
  v_society_owed numeric(12,2) := 0;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id;
  if not found then
    raise exception 'Accounting month was not found';
  end if;

  select count(*) into v_active_flats
  from public.flats
  where is_active;

  select count(*) into v_billed_flats
  from public.maintenance_charges
  where accounting_month_id = v_month.id;

  if v_month.status = 'open' then
    select count(*) into v_missing_flat_bills
    from public.flats f
    where f.is_active
      and not exists (
        select 1
        from public.maintenance_charges c
        where c.flat_id = f.id
          and c.accounting_month_id = v_month.id
      );
  else
    v_missing_flat_bills := 0;
  end if;

  select coalesce(sum(amount), 0)
  into v_total_billed
  from public.maintenance_charges
  where accounting_month_id = v_month.id;

  select coalesce(sum(p.amount), 0)
  into v_total_collected
  from public.payments p
  where p.accounting_month_id = v_month.id;

  select coalesce(sum(
    c.amount - coalesce(a.allocated_amount, 0)
  ), 0)
  into v_total_outstanding
  from public.maintenance_charges c
  left join lateral (
    select sum(pa.allocated_amount) as allocated_amount
    from public.payment_allocations pa
    join public.payments ap on ap.id = pa.payment_id
    join public.accounting_months apm on apm.id = ap.accounting_month_id
    where pa.maintenance_charge_id = c.id
      and apm.month <= v_month.month
  ) a on true
  where c.accounting_month_id = v_month.id;

  select coalesce(sum(l.amount), 0)
  into v_total_expenses
  from public.society_ledger l
  where l.accounting_month_id = v_month.id
    and l.entry_type = 'expense'
    and l.direction = 'out';

  select coalesce(sum(l.amount), 0)
  into v_borrowings_received
  from public.society_ledger l
  where l.accounting_month_id = v_month.id
    and l.entry_type = 'society_borrowing_received'
    and l.direction = 'in';

  select coalesce(sum(l.amount), 0)
  into v_borrowing_repayments
  from public.society_ledger l
  where l.accounting_month_id = v_month.id
    and l.entry_type = 'society_borrowing_repayment'
    and l.direction = 'out';

  select coalesce(sum(l.amount), 0)
  into v_other_income
  from public.society_ledger l
  where l.accounting_month_id = v_month.id
    and l.direction = 'in'
    and l.entry_type not in (
      'maintenance_collection',
      'society_borrowing_received',
      'society_borrowing_repayment'
    );

  select v_month.opening_balance + coalesce(sum(
    case when l.direction = 'in' then l.amount else -l.amount end
  ), 0)
  into v_closing_balance
  from public.society_ledger l
  where l.accounting_month_id = v_month.id;

  select coalesce(sum(b.amount), 0) - coalesce((
    select sum(r.amount)
    from public.society_borrowing_repayments r
    join public.accounting_months rm on rm.id = r.accounting_month_id
    where rm.month <= v_month.month
      and exists (
        select 1
        from public.society_borrowings rb
        join public.accounting_months rbm on rbm.id = rb.accounting_month_id
        where rb.id = r.society_borrowing_id
          and rbm.month <= v_month.month
      )
  ), 0)
  into v_society_owed
  from public.society_borrowings b
  join public.accounting_months bm on bm.id = b.accounting_month_id
  where bm.month <= v_month.month;

  return jsonb_build_object(
    'month_id', v_month.id,
    'month', v_month.month,
    'status', v_month.status,
    'opening_balance', v_month.opening_balance,
    'maintenance_billed', v_total_billed,
    'maintenance_collected', v_total_collected,
    'maintenance_outstanding', v_total_outstanding,
    'other_income', v_other_income,
    'expenses', v_total_expenses,
    'borrowings_received', v_borrowings_received,
    'borrowing_repayments', v_borrowing_repayments,
    'closing_balance', v_closing_balance,
    'monthly_surplus_deficit', v_closing_balance - v_month.opening_balance,
    'cash_deficit', greatest(0, -v_closing_balance),
    'society_owed', v_society_owed,
    'active_flats', v_active_flats,
    'billed_flats', v_billed_flats,
    'missing_flat_bills', v_missing_flat_bills
  );
end;
$$;

create or replace function public.close_accounting_month(
  p_accounting_month_id uuid,
  p_closing_notes text default null
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month public.accounting_months%rowtype;
  v_missing_flat_bills integer;
  v_closing_balance numeric(12,2);
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id
  for update;
  if not found then
    raise exception 'Accounting month was not found';
  end if;
  if v_month.status <> 'open' then
    raise exception 'Accounting month is already closed';
  end if;

  select count(*) into v_missing_flat_bills
  from public.flats f
  where f.is_active
    and not exists (
      select 1
      from public.maintenance_charges c
      where c.flat_id = f.id
        and c.accounting_month_id = v_month.id
    );

  if v_missing_flat_bills > 0 then
    raise exception 'Generate maintenance bills for all active flats before closing this month (% flat(s) still need a bill)',
      v_missing_flat_bills;
  end if;

  select v_month.opening_balance + coalesce(sum(
    case when l.direction = 'in' then l.amount else -l.amount end
  ), 0)
  into v_closing_balance
  from public.society_ledger l
  where l.accounting_month_id = v_month.id;

  if v_closing_balance < 0 then
    raise exception 'Society cash is short by %; record the funds received from an individual lender before closing',
      abs(v_closing_balance);
  end if;

  update public.accounting_months
  set closing_balance = v_closing_balance,
      status = 'closed',
      closed_at = now(),
      closed_by = auth.uid(),
      closing_notes = nullif(btrim(p_closing_notes), '')
  where id = v_month.id;

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'accounting_month_closed',
    'accounting_months',
    v_month.id,
    jsonb_build_object(
      'month', v_month.month,
      'opening_balance', v_month.opening_balance,
      'closing_balance', v_closing_balance,
      'closing_notes', nullif(btrim(p_closing_notes), '')
    )
  );

  return v_closing_balance;
end;
$$;

create or replace function public.enforce_open_accounting_month()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_month_id uuid;
  v_new_month_id uuid;
  v_month_status public.accounting_month_status;
  v_borrowing_month date;
  v_repayment_month date;
begin
  if tg_table_name = 'payment_allocations' then
    if tg_op <> 'INSERT' then
      select accounting_month_id into v_old_month_id
      from public.payments where id = old.payment_id;
      if v_old_month_id is not null then
        select status into v_month_status
        from public.accounting_months
        where id = v_old_month_id
        for update;
      end if;
      if v_old_month_id is null or v_month_status is distinct from 'open' then
        raise exception 'Transactions in a closed accounting month are read-only';
      end if;
    end if;
    if tg_op <> 'DELETE' then
      select accounting_month_id into v_new_month_id
      from public.payments where id = new.payment_id;
      if v_new_month_id is not null then
        select status into v_month_status
        from public.accounting_months
        where id = v_new_month_id
        for update;
      end if;
      if v_new_month_id is null or v_month_status is distinct from 'open' then
        raise exception 'Transactions in a closed accounting month are read-only';
      end if;
    end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_table_name = 'society_borrowing_repayments' and tg_op <> 'DELETE' then
    select borrowing_month.month, repayment_month.month
    into v_borrowing_month, v_repayment_month
    from public.society_borrowings b
    join public.accounting_months borrowing_month on borrowing_month.id = b.accounting_month_id
    join public.accounting_months repayment_month on repayment_month.id = new.accounting_month_id
    where b.id = new.society_borrowing_id;
    if not found or v_repayment_month < v_borrowing_month then
      raise exception 'A society borrowing cannot be repaid before it is received';
    end if;
  end if;

  if tg_op <> 'INSERT' then
    v_old_month_id := old.accounting_month_id;
    select status into v_month_status
    from public.accounting_months
    where id = v_old_month_id
    for update;
    if not found or v_month_status <> 'open' then
      raise exception 'Transactions in a closed accounting month are read-only';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    v_new_month_id := new.accounting_month_id;
    select status into v_month_status
    from public.accounting_months
    where id = v_new_month_id
    for update;
    if not found or v_month_status <> 'open' then
      raise exception 'Transactions in a closed accounting month are read-only';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists enforce_open_month_maintenance_charges on public.maintenance_charges;
create trigger enforce_open_month_maintenance_charges
before insert or update or delete on public.maintenance_charges
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_payments on public.payments;
create trigger enforce_open_month_payments
before insert or update or delete on public.payments
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_payment_allocations on public.payment_allocations;
create trigger enforce_open_month_payment_allocations
before insert or update or delete on public.payment_allocations
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_expenses on public.expenses;
create trigger enforce_open_month_expenses
before insert or update or delete on public.expenses
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_user_loans on public.user_loans;
create trigger enforce_open_month_user_loans
before insert or update or delete on public.user_loans
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_user_loan_repayments on public.user_loan_repayments;
create trigger enforce_open_month_user_loan_repayments
before insert or update or delete on public.user_loan_repayments
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_society_ledger on public.society_ledger;
create trigger enforce_open_month_society_ledger
before insert or update or delete on public.society_ledger
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_society_borrowings on public.society_borrowings;
create trigger enforce_open_month_society_borrowings
before insert or update or delete on public.society_borrowings
for each row execute function public.enforce_open_accounting_month();

drop trigger if exists enforce_open_month_society_borrowing_repayments on public.society_borrowing_repayments;
create trigger enforce_open_month_society_borrowing_repayments
before insert or update or delete on public.society_borrowing_repayments
for each row execute function public.enforce_open_accounting_month();

revoke all on function public.get_month_reconciliation(uuid) from public, anon, authenticated;
revoke all on function public.close_accounting_month(uuid, text) from public, anon, authenticated;
revoke all on function public.enforce_open_accounting_month() from public, anon, authenticated;
grant execute on function public.get_month_reconciliation(uuid) to authenticated;
grant execute on function public.close_accounting_month(uuid, text) to authenticated;
