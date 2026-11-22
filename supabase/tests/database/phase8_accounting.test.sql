begin;

select plan(36);

insert into auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    'a8000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'phase8-admin@example.test', 'not-a-real-password', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    'a8000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'phase8-resident-one@example.test', 'not-a-real-password', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    'a8000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'phase8-resident-two@example.test', 'not-a-real-password', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (id, full_name, role, is_active)
values
  ('a8000000-0000-4000-8000-000000000001', 'Phase 8 Admin', 'admin', true),
  ('a8000000-0000-4000-8000-000000000002', 'Phase 8 Resident One', 'resident', true),
  ('a8000000-0000-4000-8000-000000000003', 'Phase 8 Resident Two', 'resident', true);

insert into public.flats (id, flat_number, profile_id, monthly_maintenance_amount, is_active)
values
  ('a8000000-0000-4000-8000-000000000011', 'P8-1', 'a8000000-0000-4000-8000-000000000002', 5000, true),
  ('a8000000-0000-4000-8000-000000000012', 'P8-2', 'a8000000-0000-4000-8000-000000000003', 5000, true);

insert into public.expense_heads (id, name, is_active)
values ('a8000000-0000-4000-8000-000000000021', 'Phase 8 test expense', true);

insert into public.accounting_months (id, month, opening_balance, closing_balance, status)
values (
  'a8000000-0000-4000-8000-000000000031',
  '2039-12-01',
  0,
  10000,
  'closed'
);

create temporary table phase8_test_context (
  month_one uuid,
  month_two uuid,
  month_three uuid,
  charge_one uuid,
  charge_two uuid,
  borrowing_id uuid
);
grant select, insert, update on phase8_test_context to authenticated;
insert into phase8_test_context default values;

select set_config('request.jwt.claim.sub', 'a8000000-0000-4000-8000-000000000001', true);

update phase8_test_context
set month_one = public.admin_create_accounting_month('2040-01-01');

select is(
  (select opening_balance from public.accounting_months where id = (select month_one from phase8_test_context)),
  10000::numeric,
  'first month carries forward the previous closing balance'
);

select is(
  public.admin_generate_maintenance_charges(
    (select month_one from phase8_test_context),
    '2040-01-05'
  ),
  2,
  'monthly bills are generated for every active flat'
);

update phase8_test_context
set charge_one = (
  select id from public.maintenance_charges
  where flat_id = 'a8000000-0000-4000-8000-000000000011'
    and accounting_month_id = month_one
);
update phase8_test_context
set charge_two = (
  select id from public.maintenance_charges
  where flat_id = 'a8000000-0000-4000-8000-000000000012'
    and accounting_month_id = month_one
);

select lives_ok(
  format(
    'select public.admin_record_maintenance_payment(%L, %L, 2000, %L, %L, null, null, %L::jsonb)',
    'a8000000-0000-4000-8000-000000000011',
    (select month_one from phase8_test_context),
    '2040-01-10',
    'Cash',
    jsonb_build_array(jsonb_build_object('charge_id', (select charge_one from phase8_test_context), 'amount', 2000))
  ),
  'first partial maintenance payment is recorded'
);

select is(
  (
    select amount - coalesce(sum(pa.allocated_amount), 0)
    from public.maintenance_charges c
    left join public.payment_allocations pa on pa.maintenance_charge_id = c.id
    where c.id = (select charge_one from phase8_test_context)
    group by c.id
  ),
  3000::numeric,
  'partial payment leaves the correct outstanding balance'
);

select lives_ok(
  format(
    'select public.admin_record_maintenance_payment(%L, %L, 3000, %L, %L, null, null, %L::jsonb)',
    'a8000000-0000-4000-8000-000000000011',
    (select month_one from phase8_test_context),
    '2040-01-11',
    'Cash',
    jsonb_build_array(jsonb_build_object('charge_id', (select charge_one from phase8_test_context), 'amount', 3000))
  ),
  'remaining maintenance payment is recorded'
);

select is(
  (
    select amount - coalesce(sum(pa.allocated_amount), 0)
    from public.maintenance_charges c
    left join public.payment_allocations pa on pa.maintenance_charge_id = c.id
    where c.id = (select charge_one from phase8_test_context)
    group by c.id
  ),
  0::numeric,
  'fully paid maintenance bill has no outstanding balance'
);

select lives_ok(
  format(
    'select public.admin_record_maintenance_payment(%L, %L, 6000, %L, %L, null, null, %L::jsonb)',
    'a8000000-0000-4000-8000-000000000012',
    (select month_one from phase8_test_context),
    '2040-01-12',
    'Bank transfer',
    jsonb_build_array(jsonb_build_object('charge_id', (select charge_two from phase8_test_context), 'amount', 5000))
  ),
  'payment greater than the bill records the remaining amount as resident credit'
);

select is(
  (
    select p.amount - coalesce(sum(pa.allocated_amount), 0)
    from public.payments p
    left join public.payment_allocations pa on pa.payment_id = p.id
    where p.flat_id = 'a8000000-0000-4000-8000-000000000012'
      and p.accounting_month_id = (select month_one from phase8_test_context)
    group by p.id
  ),
  1000::numeric,
  'PKR 1000 remains as resident advance after paying PKR 6000 against a PKR 5000 bill'
);

select lives_ok(
  format(
    'select public.admin_record_maintenance_payment(%L, %L, 89000, %L, %L, null, null, %L::jsonb)',
    'a8000000-0000-4000-8000-000000000012',
    (select month_one from phase8_test_context),
    '2040-01-13',
    'Bank transfer',
    '[]'::jsonb
  ),
  'additional resident advance is recorded'
);

select lives_ok(
  format(
    'select public.admin_record_expense(%L, %L, 90000, %L, %L, null, %L::jsonb, null)',
    (select month_one from phase8_test_context),
    'a8000000-0000-4000-8000-000000000021',
    '2040-01-20',
    'Phase 8 test expense',
    '{}'::jsonb
  ),
  'administrator can record an expense'
);

select is(
  (public.get_month_reconciliation((select month_one from phase8_test_context))->>'closing_balance')::numeric,
  20000::numeric,
  'opening cash plus receipts less expenses reconciles to 20000'
);

select lives_ok(
  format('select public.close_accounting_month(%L, %L)', (select month_one from phase8_test_context), 'Phase 8 test'),
  'administrator closes a reconciled month'
);

select throws_ok(
  format('select public.close_accounting_month(%L, null)', (select month_one from phase8_test_context)),
  'P0001',
  'Accounting month is already closed',
  'a closed month cannot be closed again'
);

select throws_ok(
  format(
    'update public.expenses set description = %L where accounting_month_id = %L',
    'Attempted closed-month edit',
    (select month_one from phase8_test_context)
  ),
  'P0001',
  'Transactions in a closed accounting month are read-only',
  'closed-month expense edits are rejected by the database'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a8000000-0000-4000-8000-000000000002', true);

select is(
  (select count(*) from public.maintenance_charges where flat_id = 'a8000000-0000-4000-8000-000000000012'),
  0::bigint,
  'resident cannot read another flat maintenance bill'
);

select is(
  (select coalesce(sum(amount), 0) from public.payments where flat_id = 'a8000000-0000-4000-8000-000000000011'),
  5000::numeric,
  'resident can read their own payments'
);

select is(
  (select count(*) from public.payments where flat_id = 'a8000000-0000-4000-8000-000000000012'),
  0::bigint,
  'resident cannot read another flat payments'
);

select is(
  (
    select count(*)
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
    where p.flat_id = 'a8000000-0000-4000-8000-000000000012'
  ),
  0::bigint,
  'resident cannot read another flat payment allocations'
);

select is(
  (select count(*) from public.society_borrowings where lender_profile_id = 'a8000000-0000-4000-8000-000000000002'),
  1::bigint,
  'resident can read society borrowing records where they are the lender'
);

select is(
  (select count(*) from public.society_borrowings where lender_profile_id = 'a8000000-0000-4000-8000-000000000003'),
  0::bigint,
  'resident cannot read society borrowing records belonging to another lender'
);

select is(
  (select count(*) from public.notifications where profile_id = 'a8000000-0000-4000-8000-000000000003'),
  0::bigint,
  'resident cannot read another profile notifications'
);

select throws_ok(
  format(
    'select public.admin_record_expense(%L, %L, 1, %L, %L, null, %L::jsonb, null)',
    (select month_one from phase8_test_context),
    'a8000000-0000-4000-8000-000000000021',
    '2040-01-21',
    'Unauthorized expense',
    '{}'::jsonb
  ),
  'P0001',
  'Administrator access required',
  'resident cannot record an expense'
);

reset role;
select set_config('request.jwt.claim.sub', 'a8000000-0000-4000-8000-000000000001', true);

update phase8_test_context
set month_two = public.admin_create_accounting_month('2040-02-01');

select is(
  (select opening_balance from public.accounting_months where id = (select month_two from phase8_test_context)),
  20000::numeric,
  'second month starts with the exact previous closing balance'
);

select throws_like(
  format('select public.close_accounting_month(%L, null)', (select month_two from phase8_test_context)),
  'P0001',
  'Generate maintenance bills for all active flats%',
  'month close requires bills for all active flats'
);

select is(
  public.admin_generate_maintenance_charges(
    (select month_two from phase8_test_context),
    '2040-02-05'
  ),
  2,
  'second month bills are generated for all active flats'
);

update phase8_test_context
set borrowing_id = public.admin_record_society_borrowing(
  'a8000000-0000-4000-8000-000000000002',
  (select month_two from phase8_test_context),
  20000,
  '2040-02-10',
  'Phase 8 borrowing test'
);

select lives_ok(
  format(
    'select public.admin_record_society_borrowing_repayment(%L, %L, 5000, %L, null)',
    (select borrowing_id from phase8_test_context),
    (select month_two from phase8_test_context),
    '2040-02-20'
  ),
  'society records a partial lender repayment'
);

select is(
  (public.get_month_reconciliation((select month_two from phase8_test_context))->>'society_owed')::numeric,
  15000::numeric,
  'partial repayment reduces society liability to 15000'
);

select is(
  (public.get_month_reconciliation((select month_two from phase8_test_context))->>'closing_balance')::numeric,
  35000::numeric,
  'borrowing and repayment reconcile to monthly cash'
);

select lives_ok(
  format('select public.close_accounting_month(%L, null)', (select month_two from phase8_test_context)),
  'second month closes successfully'
);

update phase8_test_context
set month_three = public.admin_create_accounting_month('2040-03-01');

select is(
  (select opening_balance from public.accounting_months where id = (select month_three from phase8_test_context)),
  35000::numeric,
  'third month carries forward the prior closing balance'
);

select is(
  public.admin_generate_maintenance_charges(
    (select month_three from phase8_test_context),
    '2040-03-05'
  ),
  2,
  'third month bills are generated for all active flats'
);

select lives_ok(
  format(
    'select public.admin_record_expense(%L, %L, 120000, %L, %L, null, %L::jsonb, null)',
    (select month_three from phase8_test_context),
    'a8000000-0000-4000-8000-000000000021',
    '2040-03-15',
    'Phase 8 deficit test',
    '{}'::jsonb
  ),
  'administrator records expense that exceeds available cash'
);

select throws_like(
  format('select public.close_accounting_month(%L, null)', (select month_three from phase8_test_context)),
  'P0001',
  'Society cash is short by %',
  'month close rejects a cash deficit'
);

select lives_ok(
  format(
    'select public.admin_record_society_borrowing(%L, %L, 85000, %L, %L)',
    'a8000000-0000-4000-8000-000000000003',
    (select month_three from phase8_test_context),
    '2040-03-20',
    'Explicit deficit funding'
  ),
  'deficit is funded only by explicitly recording an individual lender'
);

select is(
  (public.get_month_reconciliation((select month_three from phase8_test_context))->>'closing_balance')::numeric,
  0::numeric,
  'explicit borrowing restores the cash balance to zero'
);

select lives_ok(
  format('select public.close_accounting_month(%L, null)', (select month_three from phase8_test_context)),
  'funded month closes successfully'
);

select * from finish();
rollback;
