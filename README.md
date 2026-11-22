# Society Maintenance Management

Mobile-first society maintenance and accounting application for one residential building.

## Stack

- React 19 + TypeScript + Vite
- Tailwind CSS 4
- Supabase Auth, PostgreSQL and Row Level Security
- Lucide icons
- Installable PWA with `vite-plugin-pwa`

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env.local` and add your Supabase project URL and publishable/anon key. Add the VAPID public key to enable push notifications.
3. Create a Supabase project and apply all SQL migrations in `supabase/migrations` in filename order.
4. Start the app:
   ```bash
   npm run dev
   ```

Without Supabase environment variables, the UI opens in demo mode and provides a resident/admin role preview switch.

## Supabase setup

Apply the migration in the Supabase SQL Editor or with the Supabase CLI:

```bash
supabase db push
```

Never expose the Supabase service-role key or VAPID private key in frontend variables. Only the VAPID public key belongs in `VITE_VAPID_PUBLIC_KEY`.

The migration includes profiles, flats, accounting months, maintenance charges, payments, allocations, expenses, expense categories, society borrowing, repayments, society ledger, notifications, subscriptions and audit logs. RLS helpers and baseline policies are included.

If you already applied the initial schema migration manually, also run `supabase/migrations/202611220001_api_grants.sql` in the SQL Editor. It grants the authenticated Supabase role the table privileges required for the existing RLS policies to take effect; it does not grant anonymous access.

Financial mutations, ledger writes and month closing use secure PostgreSQL RPC functions. Closed months are read-only; corrections must be recorded as later-period transactions rather than by editing closed history.

The resident admin screen and live dashboard require `supabase/migrations/202611220002_resident_admin_and_dashboard.sql`. The billing and payment workflows require `supabase/migrations/202611220003_maintenance_billing_and_payments.sql`. Expense management requires `supabase/migrations/202611220004_expense_management.sql`. Society ledger statements and the initial loan workflow require `supabase/migrations/202611220005_ledger_and_user_loans.sql`; the corrective `supabase/migrations/202611220006_society_borrowing.sql` adds the intended borrowing-from-individuals model, disables new society-to-resident loans, and preserves any earlier records as legacy history. Monthly reconciliation and atomic month closing require `supabase/migrations/202611220007_monthly_closing.sql`. Notification preferences, in-app notifications and push subscriptions require `supabase/migrations/202611220008_notifications.sql`. Run migrations in order. If migrations 001–007 are already applied, apply only migration 008 in the Supabase SQL Editor. Creating resident accounts requires deploying the `admin-create-resident` Edge Function:

```bash
supabase functions deploy admin-create-resident
```

Link the Supabase CLI to your project first if needed. Supabase supplies `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions; never add that key to a `VITE_` variable. An administrator enters the resident's email and sets their initial password in the app. Share those credentials securely; the password is sent only to the Edge Function and is never stored in the society tables.

Push delivery also requires deploying the sender and configuring VAPID keys:

```bash
supabase functions deploy send-push-notification
supabase secrets set VAPID_PUBLIC_KEY=replace-with-public-key VAPID_PRIVATE_KEY=replace-with-private-key VAPID_SUBJECT=admin@example.com
```

Generate a VAPID key pair with `npx web-push generate-vapid-keys`, then replace the example values in the secrets command. Put only the public key in `VITE_VAPID_PUBLIC_KEY` in local/hosting frontend settings; keep the private key in Supabase Function secrets. Then, in Supabase **Database → Webhooks**, create an `INSERT` webhook for `public.notifications` targeting your project's `/functions/v1/send-push-notification` endpoint. Set the webhook `Authorization` header to `Bearer ` followed by the service-role key (and an `apikey` header with the same key if requested). Keep this secret only in Supabase, never in the app or repository. The Edge Function verifies the webhook's service-role JWT, sends only notifications still queued for push, and removes expired subscriptions.

Users can manage device push and event preferences from the bell menu. The administrator can send maintenance reminders by selecting the due/overdue day windows there. In-app notifications work independently of push delivery. The browser requests notification permission only after a user action; denied or unsupported push does not disable in-app updates. The app shell and static assets are cached for offline launch, but financial/admin writes are blocked while offline.

The dashboard uses the database summary RPC and recorded ledger entries. The Maintenance screen supports creating accounting months, generating monthly flat charges, and recording payments with bill allocations or unallocated resident credit. The Expenses screen manages expense categories, including an optional account number, records expenses with optional private receipt uploads, and writes each expense and ledger entry atomically. Administrators can record funds lent by an individual to the society, then record partial or full repayments in the same or a later month. Borrowings increase society cash and the amount owed to the lender; repayments decrease both. The society cannot lend money to individuals. The Monthly closing screen reconciles each month, checks that every active flat has been billed, blocks closing when cash is negative, and freezes a month after the atomic close. A later month carries forward the prior month's final cash balance. The Account statement screen shows the society cash ledger to administrators and each resident's own maintenance, lending, and repayment activity. Residents can inspect monthly society expenses read-only. If no accounting month or transactions exist yet, figures remain empty/zero rather than using sample data.

### Create the first administrator

1. Apply the migration above.
2. In the Supabase Dashboard, open **Authentication → Users** and create the administrator's user with an email and password.
3. In **SQL Editor**, create the matching active administrator profile, replacing the email and name:
   ```sql
   insert into public.profiles (id, full_name, role, is_active)
   select id, 'Society Administrator', 'admin', true
   from auth.users
   where email = 'admin@example.com'
   on conflict (id) do update
   set full_name = excluded.full_name,
       role = 'admin',
       is_active = true;
   ```
4. Sign in through the app using that Auth user's email and password. The app reads the profile role after authentication.

The profile must exist and be active; Auth credentials alone do not grant administrator access. The demo role switch is only available when Supabase is not configured.

## Verification and release checks

Run the app checks before every release:

```bash
npm ci
npm run lint
npm run build
```

The GitHub Actions workflow runs lint, a production build, and the database regression suite against a disposable local Supabase stack on pushes to `main` and pull requests. The production build should generate `dist/`; the large-bundle advisory is informational but should be monitored.

The accounting/RLS regression suite is in `supabase/tests/database/phase8_accounting.test.sql`. To run it safely, use a **local disposable database**, not production:

```bash
npx supabase start
npx supabase db reset
npx supabase test db supabase/tests/database/phase8_accounting.test.sql
```

`db reset` drops and recreates the local database before applying migrations. Do not run that command against a linked or production project. Local Supabase requires Docker Desktop. The SQL test covers maintenance billing and allocations, resident advance credit, ledger reconciliation, explicit borrowing and repayment, deficit rejection, month closing/carry-forward, closed-month immutability, and resident access restrictions for payments, allocations, borrowings and notifications. Two-session concurrency checks and browser/device checks below remain release-time manual tests.

Before production release, use separate admin and resident accounts in a staging project and verify:

- Residents can read only their own profile, flat, charges, payments/allocations, borrowing records, push subscriptions and notifications; residents cannot execute admin billing, expense, borrowing or closing mutations.
- Admins can manage residents and create charges, payments, expenses, borrowings, repayments and month closes.
- A partial payment and an overpayment allocate correctly; only the excess remains as resident credit.
- Borrowings increase cash and lender liability; repayments reduce both.
- A deficit prevents month close until funds received from a named individual are explicitly recorded. A closed month rejects transaction changes and the next month opens with its exact closing balance.
- For concurrency, use two independent sessions in staging: race a payment against closing the same month, and race two close requests. Confirm the month row lock serializes operations and no payment can be committed into a closed month.
- Test install and push on supported desktop and mobile browsers over HTTPS, including permission denied, unsupported browser, opening a push notification, offline app-shell launch and rejected offline financial writes. Confirm private API data is not present in the service-worker cache.

Do not use production for destructive/RLS/concurrency tests. Confirm each test transaction and notification has the expected recipient before enabling notifications for residents.

## Deployment

Build and preview:

```bash
npm run build
npm run preview
```

The included `netlify.toml` configures the production build, SPA fallback, and conservative cache/security headers. Connect the repository to Netlify or deploy the generated `dist` directory. Configure `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and (for push) `VITE_VAPID_PUBLIC_KEY` in Netlify environment settings. Redeploy after changing frontend environment variables. Never configure a service-role key or VAPID private key in Netlify frontend variables.

Release order:

1. Verify and apply migrations 001–008 in order to the intended Supabase project. Confirm migration 008 and the push Edge Function are deployed before testing push events.
2. Deploy `send-push-notification` and `admin-create-resident`; confirm the notification insert webhook is enabled and targets the deployed push function.
3. Configure frontend environment variables in Netlify, deploy the site, and verify the site URL/HTTPS and Supabase Auth redirect allowlist.
4. Sign in as an admin and a resident; run the staging checks above, including the bell-menu test push and a real notification event through the database webhook.
5. Promote the tested build/configuration to production. Verify a test login, read-only resident access, and one controlled end-to-end notification.

### Database backups and restore

Configure the Supabase project's scheduled backups/PITR when available for its plan. Independently keep regular, encrypted exports in storage outside this repository, restrict access to administrators, and retain a tested restore procedure. The CLI can export application data from the linked project:

```powershell
npx supabase db dump --remote --data-only --schema public --file C:\secure-backups\society-data.sql
```

Choose a protected backup directory, confirm its permissions and encryption, and test restoration on a disposable project. This command exports public-schema database rows only; it is **not** a complete project backup. Preserve migrations in version control and separately plan recovery for Auth users, Storage objects/receipts, Edge Function secrets, webhook configuration and frontend environment settings. Never commit database dumps, private keys or service-role credentials.
