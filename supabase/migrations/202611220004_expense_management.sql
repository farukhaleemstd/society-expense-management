create or replace function public.admin_save_expense_head(
  p_expense_head_id uuid,
  p_name text,
  p_description text,
  p_details jsonb,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Expense head name is required';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'Expense head details must be a JSON object';
  end if;

  if p_expense_head_id is null then
    insert into public.expense_heads (name, description, details, is_active)
    values (
      btrim(p_name),
      nullif(btrim(p_description), ''),
      p_details,
      coalesce(p_is_active, true)
    )
    returning id into v_id;
  else
    update public.expense_heads
    set name = btrim(p_name),
        description = nullif(btrim(p_description), ''),
        details = p_details,
        is_active = p_is_active
    where id = p_expense_head_id
    returning id into v_id;

    if not found then
      raise exception 'Expense head was not found';
    end if;
  end if;

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    case when p_expense_head_id is null then 'expense_head_created' else 'expense_head_updated' end,
    'expense_heads',
    v_id,
    jsonb_build_object(
      'name', btrim(p_name),
      'description', nullif(btrim(p_description), ''),
      'details', p_details,
      'is_active', p_is_active
    )
  );

  return v_id;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'expense-receipts',
  'expense-receipts',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "authenticated read expense receipt files"
on storage.objects
for select to authenticated
using (
  bucket_id = 'expense-receipts'
  and exists (
    select 1
    from public.expenses e
    where e.attachment_path = name
  )
);

create policy "admins upload receipts for open months"
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'expense-receipts'
  and public.is_active_admin()
  and exists (
    select 1
    from public.accounting_months m
    where m.id::text = (storage.foldername(name))[1]
      and m.status = 'open'
  )
);

create policy "admins delete unlinked receipt uploads"
on storage.objects
for delete to authenticated
using (
  bucket_id = 'expense-receipts'
  and public.is_active_admin()
  and exists (
    select 1
    from public.accounting_months m
    where m.id::text = (storage.foldername(name))[1]
      and m.status = 'open'
  )
  and not exists (
    select 1 from public.expenses e where e.attachment_path = name
  )
);

create or replace function public.admin_record_expense(
  p_accounting_month_id uuid,
  p_expense_head_id uuid,
  p_amount numeric,
  p_expense_date date,
  p_description text,
  p_reference text,
  p_details jsonb,
  p_attachment_path text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month public.accounting_months%rowtype;
  v_expense_id uuid;
begin
  if not public.is_active_admin() then
    raise exception 'Administrator access required';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Expense amount must be positive';
  end if;
  if p_description is null or btrim(p_description) = '' then
    raise exception 'Expense description is required';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'Expense details must be a JSON object';
  end if;
  if p_expense_date is null then
    raise exception 'Expense date is required';
  end if;

  select * into v_month
  from public.accounting_months
  where id = p_accounting_month_id
  for update;
  if not found or v_month.status <> 'open' then
    raise exception 'Expense month does not exist or is not open';
  end if;
  if p_expense_date < v_month.month
     or p_expense_date >= (v_month.month + interval '1 month')::date then
    raise exception 'Expense date must fall within the selected accounting month';
  end if;
  if not exists (
    select 1 from public.expense_heads
    where id = p_expense_head_id and is_active
  ) then
    raise exception 'Active expense head was not found';
  end if;
  if p_attachment_path is not null
     and split_part(p_attachment_path, '/', 1) <> p_accounting_month_id::text then
    raise exception 'Receipt path must belong to the selected accounting month';
  end if;

  insert into public.expenses (
    accounting_month_id,
    expense_head_id,
    amount,
    expense_date,
    description,
    reference,
    details,
    attachment_path,
    recorded_by
  )
  values (
    p_accounting_month_id,
    p_expense_head_id,
    p_amount,
    p_expense_date,
    btrim(p_description),
    nullif(btrim(p_reference), ''),
    p_details,
    nullif(btrim(p_attachment_path), ''),
    auth.uid()
  )
  returning id into v_expense_id;

  insert into public.society_ledger (
    accounting_month_id,
    entry_type,
    direction,
    amount,
    source_table,
    source_id,
    description,
    created_by
  )
  values (
    p_accounting_month_id,
    'expense',
    'out',
    p_amount,
    'expenses',
    v_expense_id,
    btrim(p_description),
    auth.uid()
  );

  insert into public.audit_logs (
    actor_profile_id, action, entity_type, entity_id, after_data
  )
  values (
    auth.uid(),
    'expense_recorded',
    'expenses',
    v_expense_id,
    jsonb_build_object(
      'accounting_month_id', p_accounting_month_id,
      'expense_head_id', p_expense_head_id,
      'amount', p_amount,
      'expense_date', p_expense_date,
      'description', btrim(p_description),
      'reference', nullif(btrim(p_reference), ''),
      'details', p_details
    )
  );

  return v_expense_id;
end;
$$;

create or replace function public.get_expense_overview(p_accounting_month_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_month public.accounting_months%rowtype;
  v_heads jsonb;
  v_expenses jsonb;
begin
  select * into v_profile
  from public.profiles
  where id = auth.uid() and is_active;
  if not found then
    raise exception 'Active profile required';
  end if;

  if p_accounting_month_id is not null then
    select * into v_month
    from public.accounting_months
    where id = p_accounting_month_id;
    if not found then
      raise exception 'Accounting month was not found';
    end if;
  else
    select * into v_month
    from public.accounting_months
    order by (status = 'open') desc, month desc
    limit 1;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', h.id,
    'name', h.name,
    'description', h.description,
    'details', h.details,
    'is_active', h.is_active
  ) order by h.name), '[]'::jsonb)
  into v_heads
  from public.expense_heads h
  where v_profile.role = 'admin'
     or h.is_active
     or exists (
       select 1 from public.expenses e
       where e.expense_head_id = h.id
         and e.accounting_month_id = v_month.id
     );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'accounting_month_id', e.accounting_month_id,
    'expense_head_id', e.expense_head_id,
    'expense_head_name', h.name,
    'amount', e.amount,
    'expense_date', e.expense_date,
    'description', e.description,
    'reference', e.reference,
    'details', e.details,
    'attachment_path', e.attachment_path
  ) order by e.expense_date desc, e.created_at desc), '[]'::jsonb)
  into v_expenses
  from public.expenses e
  join public.expense_heads h on h.id = e.expense_head_id
  where e.accounting_month_id = v_month.id;

  return jsonb_build_object(
    'month_id', v_month.id,
    'month', v_month.month,
    'month_status', v_month.status,
    'expense_heads', v_heads,
    'expenses', v_expenses
  );
end;
$$;

revoke all on function public.admin_save_expense_head(uuid, text, text, jsonb, boolean) from public, anon;
revoke all on function public.admin_record_expense(uuid, uuid, numeric, date, text, text, jsonb, text) from public, anon;
revoke all on function public.get_expense_overview(uuid) from public, anon;
grant execute on function public.admin_save_expense_head(uuid, text, text, jsonb, boolean) to authenticated;
grant execute on function public.admin_record_expense(uuid, uuid, numeric, date, text, text, jsonb, text) to authenticated;
grant execute on function public.get_expense_overview(uuid) to authenticated;
