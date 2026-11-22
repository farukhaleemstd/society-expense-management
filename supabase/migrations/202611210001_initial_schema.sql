create extension if not exists pgcrypto;

create type public.user_role as enum ('admin', 'resident');
create type public.accounting_month_status as enum ('open', 'closed');
create type public.ledger_direction as enum ('in', 'out');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role public.user_role not null default 'resident',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.flats (
  id uuid primary key default gen_random_uuid(),
  flat_number text not null unique,
  floor text,
  profile_id uuid unique references public.profiles(id),
  monthly_maintenance_amount numeric(12,2) not null check (monthly_maintenance_amount >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.accounting_months (
  id uuid primary key default gen_random_uuid(),
  month date not null unique check (extract(day from month) = 1),
  opening_balance numeric(12,2) not null default 0,
  closing_balance numeric(12,2),
  status public.accounting_month_status not null default 'open',
  closed_at timestamptz,
  closed_by uuid references public.profiles(id),
  closing_notes text,
  created_at timestamptz not null default now()
);

create unique index one_open_month_idx
  on public.accounting_months ((1))
  where status = 'open';

create table public.maintenance_charges (
  id uuid primary key default gen_random_uuid(),
  flat_id uuid not null references public.flats(id),
  accounting_month_id uuid not null references public.accounting_months(id),
  amount numeric(12,2) not null check (amount >= 0),
  due_date date not null,
  created_at timestamptz not null default now(),
  unique(flat_id, accounting_month_id)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  flat_id uuid not null references public.flats(id),
  accounting_month_id uuid not null references public.accounting_months(id),
  amount numeric(12,2) not null check (amount > 0),
  payment_date date not null,
  payment_method text not null,
  reference text,
  notes text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  maintenance_charge_id uuid not null references public.maintenance_charges(id),
  allocated_amount numeric(12,2) not null check (allocated_amount > 0),
  unique(payment_id, maintenance_charge_id)
);

create table public.expense_heads (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  details jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  accounting_month_id uuid not null references public.accounting_months(id),
  expense_head_id uuid not null references public.expense_heads(id),
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null,
  description text not null,
  reference text,
  details jsonb not null default '{}'::jsonb,
  attachment_path text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.user_loans (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  accounting_month_id uuid not null references public.accounting_months(id),
  amount numeric(12,2) not null check (amount > 0),
  received_date date not null,
  notes text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.user_loan_repayments (
  id uuid primary key default gen_random_uuid(),
  user_loan_id uuid not null references public.user_loans(id),
  accounting_month_id uuid not null references public.accounting_months(id),
  amount numeric(12,2) not null check (amount > 0),
  payment_date date not null,
  notes text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.society_ledger (
  id uuid primary key default gen_random_uuid(),
  accounting_month_id uuid not null references public.accounting_months(id),
  entry_type text not null,
  direction public.ledger_direction not null,
  amount numeric(12,2) not null check (amount > 0),
  source_table text not null,
  source_id uuid not null,
  description text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(source_table, source_id, entry_type)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  title text not null,
  body text not null,
  type text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index maintenance_charges_month_idx on public.maintenance_charges(accounting_month_id);
create index payments_flat_idx on public.payments(flat_id);
create index expenses_month_idx on public.expenses(accounting_month_id);
create index user_loans_profile_idx on public.user_loans(profile_id);
create index ledger_month_idx on public.society_ledger(accounting_month_id);

create or replace function public.is_active_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active
  );
$$;

create or replace function public.my_flat_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.flats where profile_id = auth.uid();
$$;

alter table public.profiles enable row level security;
alter table public.flats enable row level security;
alter table public.accounting_months enable row level security;
alter table public.maintenance_charges enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.expense_heads enable row level security;
alter table public.expenses enable row level security;
alter table public.user_loans enable row level security;
alter table public.user_loan_repayments enable row level security;
alter table public.society_ledger enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.audit_logs enable row level security;

create policy "users read own profile" on public.profiles
  for select using (id = auth.uid() or public.is_active_admin());
create policy "admins manage profiles" on public.profiles
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "residents read own flat" on public.flats
  for select using (profile_id = auth.uid() or public.is_active_admin());
create policy "admins manage flats" on public.flats
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "authenticated read months" on public.accounting_months
  for select to authenticated using (true);
create policy "admins manage months" on public.accounting_months
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "residents read own charges" on public.maintenance_charges
  for select using (
    flat_id = public.my_flat_id() or public.is_active_admin()
  );
create policy "admins manage charges" on public.maintenance_charges
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "residents read own payments" on public.payments
  for select using (
    flat_id = public.my_flat_id() or public.is_active_admin()
  );
create policy "admins manage payments" on public.payments
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "residents read own allocations" on public.payment_allocations
  for select using (
    exists (
      select 1 from public.payments p
      where p.id = payment_id and p.flat_id = public.my_flat_id()
    ) or public.is_active_admin()
  );
create policy "admins manage allocations" on public.payment_allocations
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "authenticated read expense heads" on public.expense_heads
  for select to authenticated using (true);
create policy "admins manage expense heads" on public.expense_heads
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "authenticated read published expenses" on public.expenses
  for select to authenticated using (true);
create policy "admins manage expenses" on public.expenses
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "residents read own loans" on public.user_loans
  for select using (profile_id = auth.uid() or public.is_active_admin());
create policy "authenticated read loan public summary" on public.user_loans
  for select to authenticated using (true);
create policy "admins manage loans" on public.user_loans
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "residents read own loan repayments" on public.user_loan_repayments
  for select using (
    exists (select 1 from public.user_loans l where l.id = user_loan_id and l.profile_id = auth.uid())
    or public.is_active_admin()
  );
create policy "authenticated read repayment public summary" on public.user_loan_repayments
  for select to authenticated using (true);
create policy "admins manage loan repayments" on public.user_loan_repayments
  for all using (public.is_active_admin()) with check (public.is_active_admin());

create policy "authenticated read ledger" on public.society_ledger
  for select to authenticated using (true);
create policy "ledger is append only through privileged functions" on public.society_ledger
  for select to authenticated using (true);

create policy "users read own notifications" on public.notifications
  for select using (profile_id = auth.uid() or public.is_active_admin());
create policy "users update own notifications" on public.notifications
  for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create policy "users manage own push subscriptions" on public.push_subscriptions
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create policy "admins read audit logs" on public.audit_logs
  for select using (public.is_active_admin());
