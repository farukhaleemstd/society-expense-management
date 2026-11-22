# Society Maintenance Management System
## Product Requirements and Implementation Plan

**Purpose:** Build a small, reliable web application for one residential building. Each flat is represented by one registered user. The application tracks monthly maintenance collections, society expenses, month-end surplus/deficit, and money borrowed from individual users.

**Primary goal:** A transparent monthly accounting record that every user can inspect, with administration restricted to authorized administrators.

---

## 1. Product scope

### Included in the first release

1. One society / one building.
2. Flat records, with one registered user per flat.
3. A separately configured monthly maintenance amount for each flat.
4. Monthly maintenance bills and payment records.
5. A common society cash balance.
6. Monthly expenses entered by the administrator.
7. User advances/loans to the society when funds are insufficient.
8. Automatic carry-forward of surplus to the next month.
9. A formal month-closing process with an immutable closing record.
10. User login and role-based access.
11. User dashboard showing their bills, payments, outstanding dues and money owed back to them by the society.
12. Society dashboard showing collections, expenses, available balance and month status.
13. Installable PWA and basic push notifications.
14. Audit history for important financial actions.

### Explicitly out of scope for the first release

Do not implement these unless they become necessary later:

- Multiple societies or buildings.
- Multiple users/owners per flat.
- Tenant/owner history.
- Online payment gateway.
- Automated bank reconciliation.
- Accounting integrations.
- Payroll, staff attendance or asset management.
- Chat, complaints, polls or visitor management.
- Complex approval workflows.
- Automatic late-payment penalties (keep the data model open to adding this later).

Keep the first release focused on accurate financial records.

---

## 2. Recommended technology stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React + TypeScript + Vite | Web application |
| Styling | Tailwind CSS | Responsive UI |
| Components | A lightweight accessible component library, or custom Tailwind components | Consistent interface |
| Backend / Database | Supabase | Managed backend |
| Database | PostgreSQL | Relational data and JSONB |
| Authentication | Supabase Auth | Login and sessions |
| Authorization | PostgreSQL Row Level Security (RLS) | Enforce user permissions |
| Server-side logic | PostgreSQL functions / Supabase Edge Functions when needed | Secure financial operations and push delivery |
| Hosting | Netlify Free | Static frontend hosting |
| PWA | `vite-plugin-pwa` | Installable app and service worker |
| Push | Web Push API + VAPID | Browser push notifications |
| Charts | Recharts (optional) | Simple financial charts |
| Icons | Lucide React | UI icons |
| Source control | GitHub | Version control and deployment |

### Important deployment/security notes

- Keep the Supabase `service_role` key and VAPID private key on the server only. Never put them in React environment variables or browser code.
- The Supabase anon/publishable key may be used in the frontend only when RLS is correctly configured for every exposed table.
- Use Supabase Auth for identity. Do not build custom password storage.
- Use HTTPS in production. Netlify provides HTTPS for deployed sites.
- Free plans have quotas and may change. Supabase Free projects can pause after inactivity and do not include automatic database backups. Export the database regularly and keep a tested restore procedure.
- Netlify Free also has usage limits. Monitor usage; do not assume unlimited production traffic.
- Push notifications are not guaranteed to work on every browser/device. On iOS, users generally need to add the PWA to the Home Screen and grant notification permission. Provide in-app notifications as a fallback.

---

## 3. Core business rules

These rules are critical. Implement them consistently in database functions and tests, not only in frontend code.

### 3.1 Flat and user

- One flat has exactly one registered user in the first release.
- A user may be an administrator without being assigned to a flat.
- A flat has its own monthly maintenance amount.
- Changing a flat's maintenance amount must not change already-generated bills.
- A user must only see their own flat's bills, payments and account statement.
- Administrators can see all flats and financial records.

### 3.2 Monthly maintenance

- Each month, create one maintenance charge for every active flat.
- The charge amount is copied from that flat's configured maintenance amount at bill-generation time.
- Store the billing period as a canonical first-of-month date, e.g. `2026-11-01`.
- A charge can be unpaid, partially paid or paid. These statuses should be derived from allocations where possible, not manually edited.
- A user may pay in one or more installments.
- A payment may be allocated to one or more monthly charges.
- Unallocated payment money is an advance/credit belonging to that user. It must not silently become society income until it is allocated according to an explicit rule.
- Do not allow duplicate maintenance charges for the same flat and billing period.

### 3.3 Society cash and monthly close

For each month, calculate:

`Closing society balance = Opening society balance + Maintenance collections + Other society income + Borrowings received - Expenses paid - Borrowing repayments`

For the initial release, the main cash inflows are maintenance collections and borrowings received from individuals. If other income is not needed now, leave it out of the UI but keep the ledger model extensible. Borrowed funds are liabilities, not income.

- The previous month's closing society balance becomes the next month's opening balance.
- A positive closing balance remains in the society account and carries forward.
- A negative pre-borrowing balance means the society needs additional funding.
- The administrator records a user advance/loan to cover a deficit. This increases society cash and increases the amount the society owes that user.
- A loan/advance is not maintenance income. It is a liability owed to the lending user.
- The month cannot be closed while the society cash balance is negative.
- The month cannot be closed if required monthly charges or payments are in an invalid state, or if there are incomplete financial operations.
- A closed month is read-only. Corrections should be made using reversal/adjustment entries in a later open month, never by silently editing or deleting historical transactions.
- Only an administrator can close a month.
- Month closing must run as one atomic database transaction.

### 3.4 User loan / advance account

When a user lends PKR 20,000 to the society:

- Society cash increases by PKR 20,000.
- The user's loan/advance receivable balance increases by PKR 20,000 (the society owes the user).
- The transaction appears in the user's account statement and the society's month record.
- The amount must be visible to all users if the society's transparency policy requires it, but other users must not see private login or contact details unnecessarily.
- When the society repays PKR 5,000, society cash decreases by PKR 5,000 and the user's outstanding loan balance decreases by PKR 5,000.
- A repayment must never exceed the outstanding loan balance unless an administrator explicitly records a different type of transaction.

Use clear labels in the UI:
- **Society owes you**: outstanding user loan/advance balance.
- **You owe society**: unpaid maintenance and other charges, if introduced later.
- Do not combine these into one ambiguous balance.

### 3.5 Expense details stored as JSON

Use one reusable **Expense Head** (also called expense category) record. It can represent a utility account, security, cleaning, lift maintenance, repairs, or another recurring expense type.

Each expense head has:
- A name, e.g. `K-Electric`, `Water`, `Security`, `Lift Maintenance`.
- An optional description.
- Optional JSONB details for fields specific to that expense head.

Examples:

Utility expense head details:
```json
{
  "account_number": "123456789",
  "meter_number": "MTR-001",
  "service_address": "Main building",
  "provider": "Utility provider"
}
```

Security expense head details:
```json
{
  "contractor_name": "ABC Security Services",
  "contract_reference": "SEC-2026-01",
  "contact_number": "03000000000"
}
```

- Store the flexible fields in PostgreSQL `jsonb`, not as a JSON string.
- Validate required JSON fields in the application for each expense head. If stronger validation is needed, add a `details_schema` JSONB field later.
- Each individual expense also stores a short description, amount, expense date, optional invoice/receipt reference and optional attachment.
- Keep the expense head's JSON details separate from the individual expense's transaction details. For example, the utility account number belongs to the expense head; the bill month, invoice number and billed units belong to the individual bill/expense record.
- Do not create a separate Vendor table in the first release unless the business process needs vendors independently from expense heads. The expense head can contain supplier/account details in its JSONB metadata.

---

## 4. Suggested database schema

Use UUID primary keys, `timestamptz` for timestamps, `date` for dates, `numeric(12,2)` for PKR amounts, foreign keys, indexes and constraints.

### 4.1 `profiles`

Extends Supabase Auth users.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Same value as `auth.users.id` |
| `full_name` | text | Required |
| `phone` | text | Optional |
| `role` | text | `admin` or `resident` |
| `is_active` | boolean | Default true |
| `created_at` | timestamptz | Default now |

Do not store passwords in this table. Supabase Auth manages credentials.

### 4.2 `flats`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `flat_number` | text UNIQUE | e.g. A-101 |
| `floor` | text | Optional |
| `profile_id` | uuid UNIQUE FK | References `profiles.id`; nullable only if an unassigned flat is allowed |
| `monthly_maintenance_amount` | numeric(12,2) | Current configured amount |
| `is_active` | boolean | Default true |
| `created_at` | timestamptz | |

One flat is assigned to at most one profile. A resident profile is assigned to at most one flat in this first-release model. An admin profile does not need a flat.

### 4.3 `accounting_months`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `month` | date UNIQUE | Always first day of month |
| `opening_balance` | numeric(12,2) | Carried forward from previous month |
| `closing_balance` | numeric(12,2) nullable | Set on close |
| `status` | text | `open` or `closed` |
| `closed_at` | timestamptz nullable | |
| `closed_by` | uuid FK nullable | References profiles |
| `closing_notes` | text nullable | |
| `created_at` | timestamptz | |

Only one month should be open for normal operations at a time. Enforce this with a database constraint or secure month-management function.

### 4.4 `maintenance_charges`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `flat_id` | uuid FK | References flats |
| `accounting_month_id` | uuid FK | References accounting_months |
| `amount` | numeric(12,2) | Snapshot of amount at billing time |
| `due_date` | date | |
| `created_at` | timestamptz | |

Constraint: `UNIQUE(flat_id, accounting_month_id)`.

The charge's paid amount and outstanding amount should be calculated from `payment_allocations`. Do not keep a second editable copy of the balance.

### 4.5 `payments`

Represents money received from a flat user for maintenance.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `flat_id` | uuid FK | References flats |
| `accounting_month_id` | uuid FK | Month in which money was received |
| `amount` | numeric(12,2) | Positive amount |
| `payment_date` | date | |
| `payment_method` | text | Cash, bank transfer, etc. |
| `reference` | text nullable | Transaction/receipt reference |
| `notes` | text nullable | |
| `recorded_by` | uuid FK | Admin profile |
| `created_at` | timestamptz | |

### 4.6 `payment_allocations`

Connects a payment to one or more maintenance charges.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `payment_id` | uuid FK | References payments |
| `maintenance_charge_id` | uuid FK | References maintenance_charges |
| `allocated_amount` | numeric(12,2) | Positive amount |

A payment can have multiple allocations. A charge can receive multiple allocations. Validate that:
- Sum of allocations for a payment cannot exceed its payment amount.
- Sum of allocations for a charge cannot exceed its charge amount.
- Allocation and payment/charge ownership are consistent with the same flat.
- Allocations cannot be changed after the relevant accounting month is closed, except through a controlled reversal process.

### 4.7 `expense_heads`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | e.g. Electricity, Water, Security |
| `description` | text nullable | |
| `details` | jsonb | Default `{}` |
| `is_active` | boolean | Default true |
| `created_at` | timestamptz | |

### 4.8 `expenses`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `accounting_month_id` | uuid FK | References accounting_months |
| `expense_head_id` | uuid FK | References expense_heads |
| `amount` | numeric(12,2) | Positive amount |
| `expense_date` | date | |
| `description` | text | Details of this specific expense |
| `reference` | text nullable | Invoice/receipt number |
| `details` | jsonb | Optional per-transaction metadata |
| `attachment_path` | text nullable | Supabase Storage path |
| `recorded_by` | uuid FK | Admin profile |
| `created_at` | timestamptz | |

### 4.9 `society_borrowings`

Tracks money lent by individuals to the society and repayments.
The direction is always **individual → society**: cash received increases society cash and creates a liability to the lender. The society may repay the lender in the same or a later accounting month. The society must never lend money to residents; this table only records loans received by the society.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lender_profile_id` | uuid FK | Individual who lent the money |
| `accounting_month_id` | uuid FK | Month the advance was received |
| `amount` | numeric(12,2) | Original amount |
| `received_date` | date | |
| `notes` | text nullable | |
| `recorded_by` | uuid FK | Admin profile |
| `created_at` | timestamptz | |

### 4.10 `society_borrowing_repayments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `society_borrowing_id` | uuid FK | References society_borrowings |
| `accounting_month_id` | uuid FK | Month of repayment |
| `amount` | numeric(12,2) | Positive amount |
| `payment_date` | date | |
| `notes` | text nullable | |
| `recorded_by` | uuid FK | Admin profile |
| `created_at` | timestamptz | |

Outstanding loan balance = total loans received - total repayments.

### 4.11 `society_ledger`

This is the authoritative record of money moving into or out of the society's cash account.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `accounting_month_id` | uuid FK | References accounting_months |
| `entry_type` | text | e.g. `maintenance_collection`, `expense`, `society_borrowing_received`, `society_borrowing_repayment`, `adjustment` |
| `direction` | text | `in` or `out` |
| `amount` | numeric(12,2) | Always positive |
| `source_table` | text | Origin record type |
| `source_id` | uuid | Origin record ID |
| `description` | text | Human-readable explanation |
| `created_by` | uuid FK | Admin profile |
| `created_at` | timestamptz | |

Add a unique constraint on the appropriate source transaction and entry type to prevent duplicate ledger entries. Ledger entries should be append-only; correct mistakes with reversal entries, not deletion.

Every cash movement must create its corresponding ledger entry in the same database transaction. Do not let the frontend directly insert arbitrary ledger rows.

### 4.12 `notifications`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `profile_id` | uuid FK | Recipient |
| `title` | text | |
| `body` | text | |
| `type` | text | e.g. `maintenance_due`, `payment_recorded`, `month_closed` |
| `data` | jsonb | Optional navigation/reference data |
| `read_at` | timestamptz nullable | |
| `created_at` | timestamptz | |

### 4.13 `push_subscriptions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `profile_id` | uuid FK | Owner of subscription |
| `endpoint` | text UNIQUE | Push endpoint |
| `p256dh` | text | Public key |
| `auth` | text | Auth secret |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

A user may have multiple subscriptions because they may install the PWA on more than one device.

### 4.14 `audit_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `actor_profile_id` | uuid FK | Who performed the action |
| `action` | text | e.g. `payment_created`, `expense_created`, `month_closed` |
| `entity_type` | text | Table/entity name |
| `entity_id` | uuid | Affected record |
| `before_data` | jsonb nullable | Previous values where appropriate |
| `after_data` | jsonb nullable | New values where appropriate |
| `created_at` | timestamptz | |

Do not store passwords, access tokens, or push secrets in audit logs.

---

## 5. Accounting and month-closing workflow

### 5.1 Example month

Assume the society starts November with PKR 10,000 carried forward.

| Transaction | Amount | Society balance |
|---|---:|---:|
| Opening balance | +10,000 | 10,000 |
| Maintenance collected | +100,000 | 110,000 |
| Electricity expense | -35,000 | 75,000 |
| Security expense | -50,000 | 25,000 |
| Cleaning expense | -20,000 | 5,000 |
| **Closing balance** | | **5,000** |

The PKR 5,000 becomes December's opening balance.

### 5.2 Deficit and society borrowing

Assume:
- Opening balance: PKR 5,000
- Maintenance collected: PKR 100,000
- Expenses: PKR 125,000

Before borrowing:

`5,000 + 100,000 - 125,000 = -20,000`

The administrator records a PKR 20,000 loan from a user.

| Transaction | Amount | Society balance |
|---|---:|---:|
| Opening balance | +5,000 | 5,000 |
| Maintenance collected | +100,000 | 105,000 |
| Expenses | -125,000 | -20,000 |
| Loan received from User A | +20,000 | 0 |
| **Closing balance** | | **0** |

User A's account now shows:

`Society owes User A: PKR 20,000`

That liability remains outstanding until the society repays it. The loan is not income and must not be added to maintenance collections.

### 5.3 Month closing procedure

Create a secure PostgreSQL function/RPC such as `close_accounting_month(month_id)`.

It must perform these steps atomically:

1. Verify the caller is an active administrator.
2. Lock the accounting month row to prevent simultaneous closing.
3. Verify the month is open.
4. Verify required maintenance charges have been generated.
5. Calculate actual collections from valid payment/ledger records.
6. Calculate all expenses.
7. Calculate borrowings received from individuals and repayments made to them.
8. Calculate the final society cash balance from opening balance plus ledger movements.
9. Reject closing if the final cash balance is negative.
10. Store the final closing balance, closed timestamp and closing administrator.
11. Mark the month closed.
12. Prevent normal inserts, updates and deletes against transactions belonging to that closed month.
13. Make the next month's opening balance equal to this month's closing balance, when the next month is created.
14. Commit everything together.

If any step fails, roll back the entire operation.

**Important:** The month-closing process must not invent or automatically create a loan to hide a deficit. The administrator must explicitly record who lent the money and how much before closing.

### 5.4 Reconciliation

The month screen should show:

- Opening society balance.
- Total maintenance billed.
- Total maintenance collected.
- Total outstanding maintenance.
- Other income, if enabled.
- Total expenses.
- Borrowings received from individuals.
- Repayments made to individual lenders.
- Closing society balance.
- Total amount society owes users.

The system should show the calculation and let the administrator inspect the transactions behind every number.

---

## 6. Main application pages

### Public / authentication

- Login
- Forgot password / password reset
- Optional invite or administrator-created user onboarding

Do not allow public self-registration. The administrator should create or invite flat users and assign each profile to a flat.

### Resident pages

#### Resident dashboard

Show:
- Flat number.
- Monthly maintenance amount.
- Current month's bill and due date.
- Total unpaid maintenance.
- Society owes you (outstanding loan balance).
- Recent payments.
- Recent account activity.
- Current society month status.

#### My maintenance

- List monthly bills.
- Bill amount, due date, paid amount and outstanding amount.
- Payment history.
- Receipt/reference details.

#### My account statement

- Maintenance charges.
- Payments.
- Loan/advance given to society.
- Loan repayments received.
- Running loan balance.
- Clear distinction between amounts owed by the user and amounts owed to the user.

#### Society finances (read-only)

Allow residents to inspect:
- Monthly collections.
- Monthly expenses by expense head.
- Opening and closing balances.
- User advances/loans and repayments.
- Closed monthly statements.

For transparency, show the lending user's display name or flat number if society policy permits. Do not expose their phone, email, CNIC or private profile data.

### Administrator pages

#### Admin dashboard

- Total active flats.
- Total monthly maintenance expected.
- Current month collection.
- Outstanding maintenance.
- Current society balance.
- Current month expenses.
- Total society debt to users.
- Current month status.

#### Flats and users

- Create/edit/deactivate flat.
- Set flat number and maintenance amount.
- Invite/create a user.
- Assign one user to one flat.
- Activate/deactivate user access.
- Do not delete a flat that has financial history.

#### Maintenance

- Generate monthly bills for all active flats.
- Preview bill generation before confirming.
- Avoid duplicate bills.
- View paid, partially paid and unpaid flats.
- Record a payment for a flat.
- Allocate payment to one or more bills.
- Print/download a receipt.

#### Expenses

- Manage expense heads.
- Add/edit JSON details for each expense head.
- Add monthly expenses.
- Attach invoice or receipt if needed.
- View expenses by month and category.
- Do not allow editing/deleting an expense in a closed month.

#### Society borrowing

- Record money received from a user.
- Show outstanding amount owed to each user.
- Record partial or full repayment.
- Show loan history and statement.
- Do not count loans as maintenance income.

#### Monthly accounts

- Select month.
- Inspect all financial totals.
- Inspect ledger transactions.
- See surplus or deficit.
- Record money borrowed from an individual if required; do not offer loans from the society to individuals.
- Close month.
- View closed historical months as read-only.
- Download/print a monthly statement.

#### Settings

- Society name and basic details.
- Currency fixed to PKR for the first release.
- Default due day / due date rule.
- Notification preferences.
- Administrator account management.

---

## 7. PWA and notifications

### PWA requirements

- Responsive mobile-first interface.
- Web app manifest with app name, short name, icons, theme color and standalone display mode.
- Service worker.
- Install prompt/instructions where supported.
- App should open in an app-like standalone window after installation.
- Cache the application shell and static assets.
- Do not cache private financial API responses in a public/shared cache.
- Display an offline message when data cannot be loaded.
- Do not allow financial writes while offline in the first release.

### Push notification flow

1. User signs in.
2. User chooses **Enable notifications**.
3. App requests browser notification permission only after the user action.
4. Service worker creates a push subscription.
5. Save the subscription in `push_subscriptions`.
6. A secure server-side function sends notifications using Web Push and VAPID.
7. Handle expired subscriptions and remove invalid ones.

### Initial notification events

- New monthly maintenance bill generated.
- Payment recorded.
- Maintenance reminder before/after due date (administrator-configurable).
- Society month closed.
- Society borrowed money from the user, or repaid the user.
- Important society financial statement published.

Also show notifications inside the app. Push is an enhancement, not the only way a user receives important information.

---

## 8. Security and Row Level Security (RLS)

Enable RLS on every table exposed through Supabase APIs.

### Resident permissions

A resident can:
- Read their own profile.
- Read their assigned flat.
- Read their own maintenance charges.
- Read their own payments and allocations.
- Read their own loan/advance records and repayments.
- Read society-level monthly summaries and published expenses.
- Read notifications addressed to them.
- Manage their own push subscriptions.

A resident cannot:
- Change their role.
- Assign themselves to another flat.
- Change maintenance amounts.
- Create or edit payments.
- Create or edit expenses.
- Create loans or repayments.
- Close months.
- Read other residents' private information.
- Modify or delete ledger entries.

### Administrator permissions

An active administrator can manage operational records and perform authorized accounting actions.

Sensitive financial operations (record payment, record expense, record loan, repay loan, close month, reverse transaction) should be implemented through secure PostgreSQL functions/RPCs with role checks.

Do not rely on hiding buttons in React for security. The database must enforce permissions.

Avoid recursive RLS policies. Use carefully designed helper functions or secure SQL policies for role checks.

---

## 9. UI/UX requirements

- Mobile-first layout; most residents will use phones.
- Simple dashboard with clear financial figures.
- Use PKR formatting consistently.
- Show dates in a readable local format.
- Use clear labels: `Paid`, `Partially paid`, `Unpaid`, `Open`, `Closed`.
- Clearly distinguish society cash balance from society debt owed to users.
- Confirm before recording financial transactions and before closing a month.
- Show success/error messages for every action.
- Provide searchable/filterable transaction tables.
- Keep admin navigation separate from resident navigation.
- Avoid clutter and advanced features in the first release.
- Use accessible form labels, keyboard navigation and adequate color contrast.

---

## 10. Suggested React project structure

```text
src/
  app/
    App.tsx
    router.tsx
    providers/
  components/
    layout/
    ui/
    forms/
    tables/
    feedback/
  features/
    auth/
    dashboard/
    flats/
    users/
    maintenance/
    payments/
    expenses/
    expense-heads/
    user-loans/
    accounting-months/
    statements/
    notifications/
    settings/
  hooks/
  lib/
    supabase.ts
    currency.ts
    dates.ts
    permissions.ts
  types/
  styles/
  main.tsx

supabase/
  migrations/
  functions/
  seed.sql

public/
  icons/
  manifest.webmanifest
```

Keep database queries and mutation logic inside feature-level service modules or hooks, not scattered throughout page components.

Use generated Supabase TypeScript database types after migrations are created.

---

## 11. Implementation phases

Implement in small, testable phases. Do not generate the entire application in one pass.

### Phase 1 — Project foundation

- Create React + TypeScript + Vite project.
- Configure Tailwind CSS and routing.
- Configure Supabase project and environment variables.
- Add Supabase client.
- Create initial database migrations.
- Configure PWA manifest and basic service worker.
- Create responsive application layout.

**Acceptance criteria:** Application deploys to Netlify, connects to Supabase, and can display a basic authenticated layout.

### Phase 2 — Authentication and user management

- Supabase login/logout.
- Password reset.
- Profile table and roles.
- Admin-created/invited resident accounts.
- Flat creation and assignment.
- RLS policies.
- Protected routes and role-specific navigation.

**Acceptance criteria:** Residents can only access their own flat data; administrators can manage all flats.

### Phase 3 — Maintenance billing and payments

- Configure maintenance amount per flat.
- Create accounting months.
- Generate monthly charges.
- Prevent duplicate charge generation.
- Record payments.
- Allocate payments to charges.
- Calculate paid/unpaid balances.
- Show resident bills and payment history.
- Generate payment receipts.

**Acceptance criteria:** A flat's monthly bill, partial payments, full payments and outstanding balance are calculated correctly.

### Phase 4 — Expense management

- Create expense heads.
- Add/edit JSONB details.
- Add monthly expenses.
- Optional receipt attachment.
- Show expense lists and monthly totals.

**Acceptance criteria:** Administrator can record and inspect expenses, including category-specific metadata.

### Phase 5 — Society ledger and society borrowing

- Create ledger functions and entries.
- Ensure each cash transaction creates one ledger entry atomically.
- Record money received when an individual lends to the society; this is a liability, not income.
- Record partial/full repayments made by the society to that lender, including in a later accounting month.
- Calculate the amount the society owes each individual lender.
- Do not allow the society to lend money to individuals.
- Calculate society cash balance.
- Show society account and resident account statements.

**Acceptance criteria:** Funds lent by an individual increase society cash and the amount owed to that lender; repayments decrease both. Society cash, lender liabilities and each user's account balance reconcile correctly. No society-to-resident loan action is available.

### Phase 6 — Monthly closing

- Build month reconciliation screen.
- Calculate opening balance, collections, expenses, loans and repayments.
- Show deficit/surplus.
- If an expense creates a cash deficit, require the administrator to explicitly record the individual who provides funds to the society; never create a loan automatically.
- Implement atomic `close_accounting_month` database function.
- Freeze closed months.
- Carry closing balance into next month.
- Show historical month statements.

**Acceptance criteria:** Closed months cannot be casually edited; next month opens with the exact previous closing balance.

### Phase 7 — PWA and notifications

- Complete the installable PWA experience with install guidance, app-shell/static asset caching and an offline status; do not cache private financial responses or allow financial writes offline.
- Add per-user push preferences and device subscription management.
- Implement a secure Web Push sender using server-side VAPID secrets; deliver queued notifications through a database webhook and remove expired subscriptions.
- Create in-app notifications for maintenance bills, recorded payments, maintenance reminders, month closing, society borrowing and repayments.
- Allow administrators to send due/overdue maintenance reminders using configurable day windows.
- Handle unsupported devices, insecure origins and denied permissions gracefully; keep in-app notifications available as the fallback.

**Acceptance criteria:** Supported devices can install the app and receive a test notification after permission is granted. Financial events create recipient-scoped in-app notifications; enabled subscriptions receive push without exposing VAPID private keys or service-role credentials to the client. Private financial responses are not cached and writes are blocked offline.

### Phase 8 — Testing, deployment and handover

- Test all RLS policies using resident and admin accounts.
- Test accounting calculations and month closing.
- Test concurrent payment/closing operations.
- Test mobile layouts and PWA installation.
- Configure production environment variables.
- Deploy to Netlify.
- Apply Supabase migrations to production.
- Configure database export/backup routine.
- Write setup and deployment documentation.

**Acceptance criteria:** Production app is usable on desktop and mobile, financial records reconcile, and unauthorized users cannot perform administrative operations.

---

## 12. Required accounting test scenarios

These tests are mandatory before production.

| Scenario | Expected result |
|---|---|
| Flat has PKR 5,000 monthly charge | Monthly charge generated as PKR 5,000 |
| User pays PKR 2,000 | Outstanding charge is PKR 3,000 |
| User later pays PKR 3,000 | Charge becomes fully paid |
| User pays PKR 6,000 against a PKR 5,000 bill | PKR 5,000 allocated; PKR 1,000 remains user advance |
| Society starts with PKR 10,000, collects PKR 100,000 and spends PKR 90,000 | Closing balance PKR 20,000 |
| Next month begins after above close | Opening balance PKR 20,000 |
| Society has PKR 100,000 available but expenses are PKR 120,000 | Deficit PKR 20,000; month cannot close |
| User lends PKR 20,000 | Society balance increases by PKR 20,000 and society owes that user PKR 20,000 |
| Society repays PKR 5,000 | Society cash decreases by PKR 5,000; debt to user becomes PKR 15,000 |
| Society has a surplus after expenses | Surplus carries forward |
| Administrator attempts to close the same month twice | Second close is rejected |
| Resident attempts to record an expense | Database rejects the operation |
| Resident attempts to read another resident's private payment data | Database denies access |
| Administrator tries to edit a closed month's expense | Database rejects the operation |
| Two admins attempt to close a month simultaneously | Only one operation succeeds |

---

## 13. Important implementation guidance for Copilot

1. Start by reading this document and proposing the database migrations before implementing UI screens.
2. Do not invent additional features outside the stated scope.
3. Use TypeScript strict mode.
4. Use PostgreSQL constraints and database functions for financial integrity.
5. Use RLS for every exposed table.
6. Never calculate authoritative society balances only in React.
7. Never allow frontend code to write directly to the society ledger.
8. Use database transactions for operations that create multiple related records.
9. Use decimal/numeric values for money. Avoid JavaScript floating-point arithmetic for authoritative calculations; use integer minor units or a decimal library for client-side display/calculation.
10. Store timestamps in UTC and render dates in the user's local timezone.
11. Use migrations for all schema changes.
12. Add tests for accounting rules before building complex UI.
13. Keep closed-month records immutable, with reversal entries for corrections.
14. Do not expose Supabase service-role or VAPID private keys to the browser.
15. Do not treat a hidden React button as authorization; enforce permissions in the database.
16. Keep the UI simple and responsive.
17. After each phase, report files changed, migrations added, tests run and any remaining issues. Do not proceed to the next phase until the current phase passes its acceptance criteria.

---

## 14. First task to give Copilot

Begin with **Phase 1 and the database design foundation only**.

Ask Copilot to:

1. Review this plan.
2. Propose the final relational schema and entity relationships.
3. Create Supabase SQL migrations with tables, foreign keys, indexes, constraints and RLS policies.
4. Create the React + TypeScript + Vite project structure.
5. Configure the Supabase client using environment variables.
6. Add a minimal login page and responsive application shell.
7. Add a README containing local setup and deployment instructions.

Do not implement payments, expenses, loans or month closing yet. Those should be implemented after the database foundation and authorization rules are reviewed.

---

## 15. Official documentation

- React: https://react.dev/
- Vite: https://vite.dev/
- Supabase: https://supabase.com/docs
- Supabase Auth: https://supabase.com/docs/guides/auth
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- PostgreSQL JSON types: https://www.postgresql.org/docs/current/datatype-json.html
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Netlify: https://docs.netlify.com/
- Vite PWA: https://vite-pwa-org.netlify.app/
- MDN Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- MDN Notifications API: https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API

**Final product principle:** Every rupee entering or leaving the society must be traceable to a transaction, every user's financial position must be explainable, and every closed month must have a permanent, reproducible statement.
