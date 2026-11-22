alter table public.notifications
  add column if not exists push_status text not null default 'pending'
    check (push_status in ('pending', 'processing', 'sent', 'skipped', 'failed')),
  add column if not exists push_attempted_at timestamptz,
  add column if not exists push_error text;

create table if not exists public.notification_preferences (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  push_enabled boolean not null default false,
  maintenance_updates boolean not null default true,
  payment_updates boolean not null default true,
  society_updates boolean not null default true,
  borrowing_updates boolean not null default true,
  reminders boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;
grant select, insert, update on public.notification_preferences to authenticated;

drop policy if exists "users manage own notification preferences" on public.notification_preferences;
create policy "users manage own notification preferences"
on public.notification_preferences
for all to authenticated
using (profile_id = auth.uid())
with check (profile_id = auth.uid());

create index if not exists notifications_profile_created_idx
  on public.notifications(profile_id, created_at desc);
create index if not exists notifications_push_pending_idx
  on public.notifications(created_at)
  where push_status = 'pending';
create unique index if not exists notifications_one_reminder_per_charge_idx
  on public.notifications(profile_id, (data->>'charge_id'))
  where type = 'maintenance_reminder';

create or replace function public.create_financial_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_month date;
  v_flat_number text;
  v_title text;
  v_body text;
  v_type text;
  v_data jsonb;
begin
  if tg_table_name = 'maintenance_charges' then
    select f.profile_id, f.flat_number, m.month
    into v_profile_id, v_flat_number, v_month
    from public.flats f
    join public.accounting_months m on m.id = new.accounting_month_id
    where f.id = new.flat_id;
    v_title := 'New maintenance bill';
    v_body := 'A maintenance bill of PKR ' || to_char(new.amount, 'FM999,999,999,990.00')
      || ' for ' || to_char(v_month, 'FMMonth YYYY')
      || ' is due ' || to_char(new.due_date, 'DD Mon YYYY') || '.';
    v_type := 'maintenance_bill';
    v_data := jsonb_build_object('charge_id', new.id, 'month', v_month, 'url', '/');
  elsif tg_table_name = 'payments' then
    select f.profile_id, f.flat_number
    into v_profile_id, v_flat_number
    from public.flats f
    where f.id = new.flat_id;
    v_title := 'Maintenance payment recorded';
    v_body := 'A payment of PKR ' || to_char(new.amount, 'FM999,999,999,990.00')
      || ' was recorded for flat ' || coalesce(v_flat_number, 'your flat') || '.';
    v_type := 'payment_recorded';
    v_data := jsonb_build_object('payment_id', new.id, 'url', '/');
  elsif tg_table_name = 'society_borrowings' then
    v_profile_id := new.lender_profile_id;
    v_title := 'Society borrowing recorded';
    v_body := 'The society recorded PKR ' || to_char(new.amount, 'FM999,999,999,990.00')
      || ' received from you.';
    v_type := 'society_borrowing_received';
    v_data := jsonb_build_object('borrowing_id', new.id, 'url', '/');
  elsif tg_table_name = 'society_borrowing_repayments' then
    select b.lender_profile_id
    into v_profile_id
    from public.society_borrowings b
    where b.id = new.society_borrowing_id;
    v_title := 'Society repayment recorded';
    v_body := 'The society recorded a repayment of PKR '
      || to_char(new.amount, 'FM999,999,999,990.00') || ' to you.';
    v_type := 'society_borrowing_repayment';
    v_data := jsonb_build_object('repayment_id', new.id, 'url', '/');
  else
    return new;
  end if;

  if v_profile_id is not null then
    insert into public.notifications (profile_id, title, body, type, data)
    select v_profile_id, v_title, v_body, v_type, v_data
    where exists (
      select 1 from public.profiles
      where id = v_profile_id and is_active
    );
  end if;
  return new;
end;
$$;

drop trigger if exists notify_maintenance_charge on public.maintenance_charges;
create trigger notify_maintenance_charge
after insert on public.maintenance_charges
for each row execute function public.create_financial_notification();

drop trigger if exists notify_maintenance_payment on public.payments;
create trigger notify_maintenance_payment
after insert on public.payments
for each row execute function public.create_financial_notification();

drop trigger if exists notify_society_borrowing on public.society_borrowings;
create trigger notify_society_borrowing
after insert on public.society_borrowings
for each row execute function public.create_financial_notification();

drop trigger if exists notify_society_borrowing_repayment on public.society_borrowing_repayments;
create trigger notify_society_borrowing_repayment
after insert on public.society_borrowing_repayments
for each row execute function public.create_financial_notification();

create or replace function public.notify_closed_accounting_month()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'open' and new.status = 'closed' then
    insert into public.notifications (profile_id, title, body, type, data)
    select
      p.id,
      'Society month closed',
      'The society account for ' || to_char(new.month, 'FMMonth YYYY')
        || ' is closed. Closing cash balance: PKR '
        || to_char(new.closing_balance, 'FM999,999,999,990.00') || '.',
      'month_closed',
      jsonb_build_object('month', new.month, 'closing_balance', new.closing_balance, 'url', '/')
    from public.profiles p
    where p.is_active;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_accounting_month_closed on public.accounting_months;
create trigger notify_accounting_month_closed
after update of status on public.accounting_months
for each row execute function public.notify_closed_accounting_month();

create or replace function public.admin_create_maintenance_reminders(
  p_days_before_due integer default 3,
  p_days_after_due integer default 7
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created integer;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_days_before_due is null or p_days_after_due is null
     or p_days_before_due not between 0 and 30
     or p_days_after_due not between 0 and 90 then
    raise exception 'Reminder days are outside the allowed range';
  end if;

  with charge_balances as (
    select
      c.id,
      c.flat_id,
      c.amount - coalesce(sum(pa.allocated_amount), 0) as outstanding,
      c.due_date
    from public.maintenance_charges c
    left join public.payment_allocations pa on pa.maintenance_charge_id = c.id
    where c.due_date in (
      current_date + p_days_before_due,
      current_date - p_days_after_due
    )
    group by c.id
    having c.amount - coalesce(sum(pa.allocated_amount), 0) > 0
  ), reminders as (
    insert into public.notifications (profile_id, title, body, type, data)
    select
      f.profile_id,
      case when cb.due_date >= current_date then 'Maintenance due soon' else 'Maintenance payment overdue' end,
      case when cb.due_date >= current_date
        then 'A maintenance payment of PKR ' || to_char(cb.outstanding, 'FM999,999,999,990.00')
          || ' is due ' || to_char(cb.due_date, 'DD Mon YYYY') || '.'
        else 'An outstanding maintenance payment of PKR ' || to_char(cb.outstanding, 'FM999,999,999,990.00')
          || ' was due ' || to_char(cb.due_date, 'DD Mon YYYY') || '.'
      end,
      'maintenance_reminder',
      jsonb_build_object('charge_id', cb.id, 'due_date', cb.due_date, 'url', '/')
    from charge_balances cb
    join public.flats f on f.id = cb.flat_id
    join public.profiles p on p.id = f.profile_id and p.is_active
    on conflict (profile_id, (data->>'charge_id'))
      where type = 'maintenance_reminder' do nothing
    returning id
  )
  select count(*) into v_created from reminders;

  return v_created;
end;
$$;

revoke all on function public.create_financial_notification() from public, anon, authenticated;
revoke all on function public.notify_closed_accounting_month() from public, anon, authenticated;
revoke all on function public.admin_create_maintenance_reminders(integer, integer) from public, anon, authenticated;
grant execute on function public.admin_create_maintenance_reminders(integer, integer) to authenticated;
