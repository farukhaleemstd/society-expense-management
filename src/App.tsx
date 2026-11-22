import { useEffect, useState } from 'react'
import {
  Bell,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDollarSign,
  LayoutDashboard,
  LogOut,
  Pencil,
  Plus,
  ReceiptText,
  Settings,
  Users,
  UserRound,
  WalletCards,
  Wrench,
} from 'lucide-react'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { formatPKR } from './lib/currency'
import { firstOfMonth, formatMonth } from './lib/dates'
import './App.css'

type View = 'dashboard' | 'maintenance' | 'society' | 'account' | 'flats' | 'expenses' | 'loans' | 'closing' | 'settings'

const viewLabels: Record<View, string> = {
  dashboard: 'Overview',
  maintenance: 'My maintenance',
  society: 'Society finances',
  account: 'Account statement',
  flats: 'Flats & users',
  expenses: 'Expenses',
  loans: 'Society borrowing',
  closing: 'Monthly closing',
  settings: 'Settings',
}

interface DashboardSummary {
  role: 'admin' | 'resident'
  month: string | null
  month_status: 'open' | 'closed' | null
  opening_balance: number | null
  flat_number: string | null
  monthly_maintenance_amount: number | null
  current_bill: number
  unpaid_maintenance: number
  total_billed: number
  month_billed: number
  collected: number
  expenses: number
  society_balance: number | null
  society_owed: number
}

interface DashboardCharge {
  id: string
  amount: number
  due_date: string
  flat_number: string
  allocated: number
}

interface ResidentRecord {
  id: string
  full_name: string
  phone: string | null
  is_active: boolean
  flat: {
    id: string
    flat_number: string
    floor: string | null
    monthly_maintenance_amount: number
    is_active: boolean
  } | null
}

interface ResidentForm {
  fullName: string
  email: string
  password: string
  confirmPassword: string
  phone: string
  flatNumber: string
  floor: string
  monthlyMaintenanceAmount: string
  isActive: boolean
  flatIsActive: boolean
}

interface AccountingMonth {
  id: string
  month: string
  opening_balance: number
  closing_balance: number | null
  status: 'open' | 'closed'
}

interface MonthReconciliation {
  month_id: string
  month: string
  status: 'open' | 'closed'
  opening_balance: number
  maintenance_billed: number
  maintenance_collected: number
  maintenance_outstanding: number
  other_income: number
  expenses: number
  borrowings_received: number
  borrowing_repayments: number
  closing_balance: number
  monthly_surplus_deficit: number
  cash_deficit: number
  society_owed: number
  active_flats: number
  billed_flats: number
  missing_flat_bills: number
}

interface AccountStatementEntry {
  id: string
  entry_date: string
  entry_type: string
  direction: 'in' | 'out'
  amount: number
  description: string
  balance_after: number
}

interface AccountStatement {
  month: string
  month_status: 'open' | 'closed'
  opening_balance: number
  closing_balance: number
  entries: AccountStatementEntry[]
}

interface SocietyBorrowing {
  id: string
  lender_profile_id: string
  lender_name: string
  flat_number: string | null
  accounting_month_id: string
  month: string
  amount: number
  received_date: string
  notes: string | null
  repaid: number
  outstanding: number
}

interface UserNotification {
  id: string
  title: string
  body: string
  type: string
  read_at: string | null
  created_at: string
}

interface NotificationPreferences {
  push_enabled: boolean
  maintenance_updates: boolean
  payment_updates: boolean
  society_updates: boolean
  borrowing_updates: boolean
  reminders: boolean
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const defaultNotificationPreferences: NotificationPreferences = {
  push_enabled: false,
  maintenance_updates: true,
  payment_updates: true,
  society_updates: true,
  borrowing_updates: true,
  reminders: true,
}

const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY

function decodeVapidKey(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return buffer
}

interface MaintenanceBill {
  id: string
  flat_id: string
  flat_number: string
  accounting_month_id: string
  month: string
  amount: number
  due_date: string
  paid: number
  outstanding: number
}

interface MaintenancePayment {
  id: string
  flat_id: string
  flat_number: string
  amount: number
  payment_date: string
  payment_method: string
  reference: string | null
  notes: string | null
  allocated: number
  credit: number
}

interface MaintenanceOverview {
  charges: MaintenanceBill[]
  payments: MaintenancePayment[]
}

interface FlatOption {
  id: string
  flat_number: string
  monthly_maintenance_amount: number
}

interface PaymentAllocationInput {
  chargeId: string
  amount: string
}

interface ExpenseHead {
  id: string
  name: string
  description: string | null
  details: Record<string, unknown>
  is_active: boolean
}

interface ExpenseRecord {
  id: string
  accounting_month_id: string
  expense_head_id: string
  expense_head_name: string
  amount: number
  expense_date: string
  description: string
  reference: string | null
  details: Record<string, unknown>
  attachment_path: string | null
}

interface ExpenseOverview {
  month_id: string | null
  month: string | null
  month_status: 'open' | 'closed' | null
  expense_heads: ExpenseHead[]
  expenses: ExpenseRecord[]
}

interface ExpenseHeadForm {
  name: string
  description: string
  accountNumber: string
  isActive: boolean
}

interface ExpenseForm {
  headId: string
  amount: string
  date: string
  description: string
  reference: string
}

const emptyResidentForm: ResidentForm = {
  fullName: '',
  email: '',
  password: '',
  confirmPassword: '',
  phone: '',
  flatNumber: '',
  floor: '',
  monthlyMaintenanceAmount: '',
  isActive: true,
  flatIsActive: true,
}

function monthDateFor(date: string, day: number): string {
  const [year, month] = date.split('-')
  return `${year}-${month}-${String(day).padStart(2, '0')}`
}

function localDate(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function getAccountNumber(details: Record<string, unknown>): string {
  const value = details.account_number
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark"><Building2 size={20} /></div>
      <div>
        <strong>North View Luxury Apartments</strong>
        <span>Society accounts</span>
      </div>
    </div>
  )
}

async function loadProfile(userId: string) {
  if (!supabase) throw new Error('Supabase is not configured.')

  const { data, error } = await supabase
    .from('profiles')
    .select('full_name, role, is_active')
    .eq('id', userId)
    .single()

  if (error) throw new Error(`Could not load your profile: ${error.message}`)
  if (!data.is_active) throw new Error('Your account is inactive. Contact a society administrator.')
  if (data.role !== 'admin' && data.role !== 'resident') {
    throw new Error('Your account has an unsupported role.')
  }

  return { name: data.full_name, role: data.role }
}

async function loadDashboardData(): Promise<{ summary: DashboardSummary; charges: DashboardCharge[] }> {
  if (!supabase) throw new Error('Supabase is not configured.')

  const { data: summaryData, error: summaryError } = await supabase.rpc('get_dashboard_summary')
  if (summaryError) throw new Error(`Could not load dashboard summary: ${summaryError.message}`)
  if (!summaryData) throw new Error('Dashboard summary was empty.')

  const summary = summaryData as unknown as DashboardSummary
  if (!summary.month) return { summary, charges: [] }

  const { data: monthData, error: monthError } = await supabase
    .from('accounting_months')
    .select('id')
    .eq('month', summary.month)
    .maybeSingle()
  if (monthError) throw new Error(`Could not load accounting month: ${monthError.message}`)
  if (!monthData) return { summary, charges: [] }

  const { data: chargeData, error: chargeError } = await supabase
    .from('maintenance_charges')
    .select('id, flat_id, amount, due_date')
    .eq('accounting_month_id', monthData.id)
    .order('due_date', { ascending: true })
    .limit(5)
  if (chargeError) throw new Error(`Could not load recent bills: ${chargeError.message}`)
  const chargeRows = chargeData ?? []
  if (chargeRows.length === 0) return { summary, charges: [] }

  const chargeIds = chargeRows.map((charge) => charge.id)
  const flatIds = [...new Set(chargeRows.map((charge) => charge.flat_id))]
  const [{ data: flatData, error: flatError }, { data: allocationData, error: allocationError }] = await Promise.all([
    supabase.from('flats').select('id, flat_number').in('id', flatIds),
    supabase.from('payment_allocations').select('maintenance_charge_id, allocated_amount').in('maintenance_charge_id', chargeIds),
  ])
  if (flatError) throw new Error(`Could not load flat labels: ${flatError.message}`)
  if (allocationError) throw new Error(`Could not load bill allocations: ${allocationError.message}`)

  const flatLabels = new Map((flatData ?? []).map((flat) => [flat.id, flat.flat_number]))
  const allocated = new Map<string, number>()
  for (const allocation of allocationData ?? []) {
    allocated.set(
      allocation.maintenance_charge_id,
      (allocated.get(allocation.maintenance_charge_id) ?? 0) + Number(allocation.allocated_amount),
    )
  }

  return {
    summary,
    charges: chargeRows.map((charge) => ({
      id: charge.id,
      amount: Number(charge.amount),
      due_date: charge.due_date,
      flat_number: flatLabels.get(charge.flat_id) ?? 'Flat',
      allocated: allocated.get(charge.id) ?? 0,
    })),
  }
}

async function loadResidents(): Promise<ResidentRecord[]> {
  if (!supabase) throw new Error('Supabase is not configured.')

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, full_name, phone, is_active')
    .eq('role', 'resident')
    .order('full_name')
  if (profileError) throw new Error(`Could not load residents: ${profileError.message}`)
  if (!profiles?.length) return []

  const profileIds = profiles.map((profile) => profile.id)
  const { data: flats, error: flatError } = await supabase
    .from('flats')
    .select('id, profile_id, flat_number, floor, monthly_maintenance_amount, is_active')
    .in('profile_id', profileIds)
  if (flatError) throw new Error(`Could not load resident flats: ${flatError.message}`)

  const flatsByProfile = new Map((flats ?? []).map((flat) => [flat.profile_id, flat]))
  return profiles.map((profile) => {
    const flat = flatsByProfile.get(profile.id)
    return {
      ...profile,
      flat: flat ? {
        id: flat.id,
        flat_number: flat.flat_number,
        floor: flat.floor,
        monthly_maintenance_amount: Number(flat.monthly_maintenance_amount),
        is_active: flat.is_active,
      } : null,
    }
  })
}

async function loadAccountingMonths(): Promise<AccountingMonth[]> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase
    .from('accounting_months')
    .select('id, month, opening_balance, closing_balance, status')
    .order('month', { ascending: false })
  if (error) throw new Error(`Could not load accounting months: ${error.message}`)
  return (data ?? []).map((month) => ({
    ...month,
    opening_balance: Number(month.opening_balance),
    closing_balance: month.closing_balance === null ? null : Number(month.closing_balance),
  }))
}

async function loadMonthReconciliation(monthId: string): Promise<MonthReconciliation> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.rpc('get_month_reconciliation', {
    p_accounting_month_id: monthId,
  })
  if (error) throw new Error(`Could not load month reconciliation: ${error.message}`)
  if (!data) throw new Error('Month reconciliation was empty.')

  const reconciliation = data as unknown as MonthReconciliation
  return {
    ...reconciliation,
    opening_balance: Number(reconciliation.opening_balance),
    maintenance_billed: Number(reconciliation.maintenance_billed),
    maintenance_collected: Number(reconciliation.maintenance_collected),
    maintenance_outstanding: Number(reconciliation.maintenance_outstanding),
    other_income: Number(reconciliation.other_income),
    expenses: Number(reconciliation.expenses),
    borrowings_received: Number(reconciliation.borrowings_received),
    borrowing_repayments: Number(reconciliation.borrowing_repayments),
    closing_balance: Number(reconciliation.closing_balance),
    monthly_surplus_deficit: Number(reconciliation.monthly_surplus_deficit),
    cash_deficit: Number(reconciliation.cash_deficit),
    society_owed: Number(reconciliation.society_owed),
    active_flats: Number(reconciliation.active_flats),
    billed_flats: Number(reconciliation.billed_flats),
    missing_flat_bills: Number(reconciliation.missing_flat_bills),
  }
}

async function loadAccountStatement(monthId: string): Promise<AccountStatement> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.rpc('get_account_statement', {
    p_accounting_month_id: monthId,
  })
  if (error) throw new Error(`Could not load account statement: ${error.message}`)
  if (!data) throw new Error('Account statement was empty.')

  const statement = data as unknown as AccountStatement
  return {
    ...statement,
    opening_balance: Number(statement.opening_balance),
    closing_balance: Number(statement.closing_balance),
    entries: (statement.entries ?? []).map((entry) => ({
      ...entry,
      amount: Number(entry.amount),
      balance_after: Number(entry.balance_after),
    })),
  }
}

async function loadAdminSocietyBorrowings(): Promise<SocietyBorrowing[]> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.rpc('get_admin_society_borrowings')
  if (error) throw new Error(`Could not load society borrowings: ${error.message}`)
  return ((data ?? []) as unknown as SocietyBorrowing[]).map((borrowing) => ({
    ...borrowing,
    amount: Number(borrowing.amount),
    repaid: Number(borrowing.repaid),
    outstanding: Number(borrowing.outstanding),
  }))
}

async function loadMaintenanceOverview(monthId: string): Promise<MaintenanceOverview> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.rpc('get_maintenance_overview', {
    p_accounting_month_id: monthId,
  })
  if (error) throw new Error(`Could not load maintenance records: ${error.message}`)
  if (!data) return { charges: [], payments: [] }

  const overview = data as unknown as MaintenanceOverview
  return {
    charges: (overview.charges ?? []).map((charge) => ({
      ...charge,
      amount: Number(charge.amount),
      paid: Number(charge.paid),
      outstanding: Number(charge.outstanding),
    })),
    payments: (overview.payments ?? []).map((payment) => ({
      ...payment,
      amount: Number(payment.amount),
      allocated: Number(payment.allocated),
      credit: Number(payment.credit),
    })),
  }
}

async function loadFlatOutstandingCharges(flatId: string): Promise<MaintenanceBill[]> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.rpc('admin_get_flat_open_charges', { p_flat_id: flatId })
  if (error) throw new Error(`Could not load outstanding bills: ${error.message}`)
  const rows = (data ?? []) as unknown as MaintenanceBill[]
  return rows.map((charge) => ({
    ...charge,
    amount: Number(charge.amount),
    paid: Number(charge.paid),
    outstanding: Number(charge.outstanding),
  }))
}

async function loadActiveFlats(): Promise<FlatOption[]> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase
    .from('flats')
    .select('id, flat_number, monthly_maintenance_amount')
    .eq('is_active', true)
    .order('flat_number')
  if (error) throw new Error(`Could not load active flats: ${error.message}`)
  return (data ?? []).map((flat) => ({
    ...flat,
    monthly_maintenance_amount: Number(flat.monthly_maintenance_amount),
  }))
}

async function loadExpenseOverview(monthId: string | null): Promise<ExpenseOverview> {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data, error } = await supabase.rpc('get_expense_overview', {
    p_accounting_month_id: monthId,
  })
  if (error) throw new Error(`Could not load expenses: ${error.message}`)
  if (!data) return { month_id: null, month: null, month_status: null, expense_heads: [], expenses: [] }

  const result = data as unknown as ExpenseOverview
  return {
    ...result,
    expense_heads: result.expense_heads ?? [],
    expenses: (result.expenses ?? []).map((expense) => ({
      ...expense,
      amount: Number(expense.amount),
    })),
  }
}

function App() {
  const [signedIn, setSignedIn] = useState(false)
  const [authChecking, setAuthChecking] = useState(isSupabaseConfigured)
  const [role, setRole] = useState<'resident' | 'admin'>('resident')
  const [profileName, setProfileName] = useState('Shayan Ali')
  const [view, setView] = useState<View>('dashboard')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(window.matchMedia('(display-mode: standalone)').matches)
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false)
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0)
  const [notificationPreferences, setNotificationPreferences] = useState(defaultNotificationPreferences)
  const [devicePushEnabled, setDevicePushEnabled] = useState(false)
  const [notificationLoading, setNotificationLoading] = useState(false)
  const [notificationSaving, setNotificationSaving] = useState(false)
  const [notificationError, setNotificationError] = useState('')
  const [notificationNotice, setNotificationNotice] = useState('')
  const [reminderBeforeDays, setReminderBeforeDays] = useState('3')
  const [reminderAfterDays, setReminderAfterDays] = useState('7')
  const [reminderSending, setReminderSending] = useState(false)
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null)
  const [dashboardCharges, setDashboardCharges] = useState<DashboardCharge[]>([])
  const [dashboardLoading, setDashboardLoading] = useState(isSupabaseConfigured)
  const [dashboardError, setDashboardError] = useState('')
  const [residents, setResidents] = useState<ResidentRecord[]>([])
  const [residentsLoading, setResidentsLoading] = useState(false)
  const [residentsError, setResidentsError] = useState('')
  const [residentFormOpen, setResidentFormOpen] = useState(false)
  const [editingResidentId, setEditingResidentId] = useState<string | null>(null)
  const [residentForm, setResidentForm] = useState<ResidentForm>(emptyResidentForm)
  const [residentSaving, setResidentSaving] = useState(false)
  const [residentNotice, setResidentNotice] = useState('')
  const [accountingMonths, setAccountingMonths] = useState<AccountingMonth[]>([])
  const [selectedMonthId, setSelectedMonthId] = useState('')
  const [financeMonths, setFinanceMonths] = useState<AccountingMonth[]>([])
  const [financeMonthId, setFinanceMonthId] = useState('')
  const [accountStatement, setAccountStatement] = useState<AccountStatement | null>(null)
  const [statementLoading, setStatementLoading] = useState(false)
  const [statementError, setStatementError] = useState('')
  const [loanRecords, setLoanRecords] = useState<SocietyBorrowing[]>([])
  const [loansLoading, setLoansLoading] = useState(false)
  const [loansError, setLoansError] = useState('')
  const [loansNotice, setLoansNotice] = useState('')
  const [loanSaving, setLoanSaving] = useState(false)
  const [closingMonths, setClosingMonths] = useState<AccountingMonth[]>([])
  const [closingMonthId, setClosingMonthId] = useState('')
  const [monthReconciliation, setMonthReconciliation] = useState<MonthReconciliation | null>(null)
  const [closingLoading, setClosingLoading] = useState(false)
  const [closingError, setClosingError] = useState('')
  const [closingNotice, setClosingNotice] = useState('')
  const [closingSaving, setClosingSaving] = useState(false)
  const [closingNotes, setClosingNotes] = useState('')
  const [loanFormOpen, setLoanFormOpen] = useState(false)
  const [loanResidentId, setLoanResidentId] = useState('')
  const [loanAmount, setLoanAmount] = useState('')
  const [loanDate, setLoanDate] = useState(localDate())
  const [loanNotes, setLoanNotes] = useState('')
  const [repaymentLoanId, setRepaymentLoanId] = useState<string | null>(null)
  const [repaymentAmount, setRepaymentAmount] = useState('')
  const [repaymentDate, setRepaymentDate] = useState(localDate())
  const [repaymentNotes, setRepaymentNotes] = useState('')
  const [maintenanceOverview, setMaintenanceOverview] = useState<MaintenanceOverview>({ charges: [], payments: [] })
  const [maintenanceLoading, setMaintenanceLoading] = useState(false)
  const [maintenanceError, setMaintenanceError] = useState('')
  const [maintenanceNotice, setMaintenanceNotice] = useState('')
  const [newMonthValue, setNewMonthValue] = useState(firstOfMonth().slice(0, 7))
  const [dueDate, setDueDate] = useState('')
  const [maintenanceFlats, setMaintenanceFlats] = useState<FlatOption[]>([])
  const [paymentTargetFlatId, setPaymentTargetFlatId] = useState('')
  const [paymentAllocations, setPaymentAllocations] = useState<PaymentAllocationInput[]>([])
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(localDate())
  const [paymentMethod, setPaymentMethod] = useState('Cash')
  const [paymentReference, setPaymentReference] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [paymentSaving, setPaymentSaving] = useState(false)
  const [paymentFormOpen, setPaymentFormOpen] = useState(false)
  const [paymentChargesLoading, setPaymentChargesLoading] = useState(false)
  const [paymentChargeOptions, setPaymentChargeOptions] = useState<MaintenanceBill[]>([])
  const [expenseMonths, setExpenseMonths] = useState<AccountingMonth[]>([])
  const [expenseMonthId, setExpenseMonthId] = useState('')
  const [expenseOverview, setExpenseOverview] = useState<ExpenseOverview>({
    month_id: null,
    month: null,
    month_status: null,
    expense_heads: [],
    expenses: [],
  })
  const [expenseLoading, setExpenseLoading] = useState(false)
  const [expenseError, setExpenseError] = useState('')
  const [societySummary, setSocietySummary] = useState<MonthReconciliation | null>(null)
  const [societySummaryLoading, setSocietySummaryLoading] = useState(false)
  const [societySummaryError, setSocietySummaryError] = useState('')
  const [expenseNotice, setExpenseNotice] = useState('')
  const [headFormOpen, setHeadFormOpen] = useState(false)
  const [editingHeadId, setEditingHeadId] = useState<string | null>(null)
  const [headForm, setHeadForm] = useState<ExpenseHeadForm>({
    name: '',
    description: '',
    accountNumber: '',
    isActive: true,
  })
  const [expenseFormOpen, setExpenseFormOpen] = useState(false)
  const [expenseForm, setExpenseForm] = useState<ExpenseForm>({
    headId: '',
    amount: '',
    date: localDate(),
    description: '',
    reference: '',
  })
  const [expenseAttachment, setExpenseAttachment] = useState<File | null>(null)
  const [expenseSaving, setExpenseSaving] = useState(false)
  const [expenseCategoryFilter, setExpenseCategoryFilter] = useState('')

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(navigator.onLine)
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    const handleInstalled = () => {
      setIsInstalled(true)
      setInstallPrompt(null)
    }
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
      window.removeEventListener('appinstalled', handleInstalled)
    }
  }, [])

  useEffect(() => {
    if (!signedIn || !supabase) return

    const client = supabase
    let active = true
    const loadUnreadCount = async () => {
      const { data: { user }, error: userError } = await client.auth.getUser()
      if (userError) throw new Error(`Could not identify your account: ${userError.message}`)
      if (!user) return
      const { count, error: countError } = await client
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('profile_id', user.id)
        .is('read_at', null)
      if (countError) throw new Error(`Could not load unread notifications: ${countError.message}`)
      if (active) setUnreadNotificationCount(count ?? 0)
    }

    void loadUnreadCount().catch((loadError: unknown) => {
      if (active) setNotificationError(loadError instanceof Error ? loadError.message : 'Could not load notifications.')
    })
    const intervalId = window.setInterval(() => {
      void loadUnreadCount().catch((loadError: unknown) => {
        if (active) setNotificationError(loadError instanceof Error ? loadError.message : 'Could not refresh notifications.')
      })
    }, 60_000)
    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [signedIn])

  useEffect(() => {
    if (!notificationPanelOpen || !signedIn || !supabase) return

    let active = true
    void loadNotificationPanel()
      .catch((loadError: unknown) => {
        if (active) setNotificationError(loadError instanceof Error ? loadError.message : 'Could not load notifications.')
      })
      .finally(() => {
        if (active) setNotificationLoading(false)
      })

    return () => { active = false }
  }, [notificationPanelOpen, signedIn])

  useEffect(() => {
    if (!signedIn || (view !== 'expenses' && view !== 'society') || !supabase) return

    let active = true
    void loadAccountingMonths()
      .then((months) => {
        if (!active) return
        setExpenseMonths(months)
        const selectedExists = months.some((month) => month.id === expenseMonthId)
        if (!selectedExists) {
          const nextMonthId = (months.find((month) => month.status === 'open') ?? months[0])?.id ?? ''
          setExpenseMonthId(nextMonthId)
          if (!nextMonthId && role === 'admin') {
            setSocietySummary(null)
            setSocietySummaryLoading(false)
          }
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setExpenseError(loadError instanceof Error ? loadError.message : 'Could not load accounting months.')
          if (role === 'admin') setSocietySummaryLoading(false)
        }
      })

    return () => { active = false }
  }, [signedIn, role, view, expenseMonthId])

  useEffect(() => {
    if (!signedIn || role !== 'admin' || view !== 'society' || !expenseMonthId || !supabase) return

    let active = true
    void loadMonthReconciliation(expenseMonthId)
      .then((reconciliation) => {
        if (active) setSocietySummary(reconciliation)
      })
      .catch((loadError: unknown) => {
        if (active) {
          setSocietySummary(null)
          setSocietySummaryError(loadError instanceof Error ? loadError.message : 'Could not load society finances.')
        }
      })
      .finally(() => {
        if (active) setSocietySummaryLoading(false)
      })

    return () => { active = false }
  }, [signedIn, role, view, expenseMonthId])

  useEffect(() => {
    if (!signedIn || (view !== 'expenses' && view !== 'society') || !supabase) return

    let active = true
    void loadExpenseOverview(expenseMonthId || null)
      .then((overview) => {
        if (!active) return
        setExpenseOverview(overview)
        setExpenseMonthId((current) => current || overview.month_id || '')
      })
      .catch((loadError: unknown) => {
        if (active) setExpenseError(loadError instanceof Error ? loadError.message : 'Could not load expenses.')
      })
      .finally(() => {
        if (active) setExpenseLoading(false)
      })

    return () => { active = false }
  }, [signedIn, role, view, expenseMonthId])

  useEffect(() => {
    if (!signedIn || view !== 'maintenance' || !supabase) return

    let active = true
    void Promise.all([
      loadAccountingMonths(),
      role === 'admin' ? loadActiveFlats() : Promise.resolve([] as FlatOption[]),
    ])
      .then(([months, flats]) => {
        if (!active) return
        setAccountingMonths(months)
        setMaintenanceFlats(flats)
        const selectedExists = months.some((month) => month.id === selectedMonthId)
        const nextMonth = selectedExists
          ? selectedMonthId
          : (months.find((month) => month.status === 'open') ?? months[0])?.id ?? ''
        setSelectedMonthId(nextMonth)
        if (nextMonth) {
          const month = months.find((row) => row.id === nextMonth)
          setDueDate(month ? monthDateFor(month.month, 5) : '')
        } else {
          setMaintenanceOverview({ charges: [], payments: [] })
          setMaintenanceLoading(false)
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setMaintenanceError(loadError instanceof Error ? loadError.message : 'Could not load maintenance setup.')
          setMaintenanceLoading(false)
        }
      })

    return () => { active = false }
  }, [signedIn, role, view, selectedMonthId])

  useEffect(() => {
    if (!signedIn || view !== 'maintenance' || !selectedMonthId || !supabase) return

    let active = true
    void loadMaintenanceOverview(selectedMonthId)
      .then((overview) => {
        if (active) setMaintenanceOverview(overview)
      })
      .catch((loadError: unknown) => {
        if (active) setMaintenanceError(loadError instanceof Error ? loadError.message : 'Could not load maintenance records.')
      })
      .finally(() => {
        if (active) setMaintenanceLoading(false)
      })

    return () => { active = false }
  }, [signedIn, view, selectedMonthId, role])

  useEffect(() => {
    if (!signedIn || view !== 'dashboard' || !supabase) return

    let active = true
    void loadDashboardData()
      .then(({ summary, charges }) => {
        if (!active) return
        setDashboard(summary)
        setDashboardCharges(charges)
      })
      .catch((loadError: unknown) => {
        if (active) setDashboardError(loadError instanceof Error ? loadError.message : 'Could not load dashboard data.')
      })
      .finally(() => {
        if (active) setDashboardLoading(false)
      })

    return () => { active = false }
  }, [signedIn, view, role])

  useEffect(() => {
    if (!signedIn || role !== 'admin' || view !== 'flats') return

    let active = true
    void loadResidents()
      .then((rows) => { if (active) setResidents(rows) })
      .catch((loadError: unknown) => {
        if (active) setResidentsError(loadError instanceof Error ? loadError.message : 'Could not load residents.')
      })
      .finally(() => { if (active) setResidentsLoading(false) })

    return () => { active = false }
  }, [signedIn, role, view])

  useEffect(() => {
    if (!signedIn || (view !== 'account' && view !== 'loans') || !supabase) return

    let active = true
    void loadAccountingMonths()
      .then((months) => {
        if (!active) return
        setFinanceMonths(months)
        setFinanceMonthId((current) => months.some((month) => month.id === current)
          ? current
          : (months.find((month) => month.status === 'open') ?? months[0])?.id ?? '')
      })
      .catch((loadError: unknown) => {
        if (active) {
          const message = loadError instanceof Error ? loadError.message : 'Could not load accounting months.'
          if (view === 'account') setStatementError(message)
          else setLoansError(message)
        }
      })

    return () => { active = false }
  }, [signedIn, role, view])

  useEffect(() => {
    if (!signedIn || role !== 'admin' || view !== 'closing' || !supabase) return

    let active = true
    void loadAccountingMonths()
      .then((months) => {
        if (!active) return
        setClosingMonths(months)
        const nextMonthId = months.some((month) => month.id === closingMonthId)
          ? closingMonthId
          : (months.find((month) => month.status === 'open') ?? months[0])?.id ?? ''
        setClosingMonthId((current) => current === nextMonthId ? current : nextMonthId)
        if (!nextMonthId) {
          setMonthReconciliation(null)
          setClosingLoading(false)
        }
      })
      .catch((loadError: unknown) => {
        if (active) {
          setClosingError(loadError instanceof Error ? loadError.message : 'Could not load accounting months.')
          setClosingLoading(false)
        }
      })

    return () => { active = false }
  }, [signedIn, role, view, closingMonthId])

  useEffect(() => {
    if (!signedIn || role !== 'admin' || view !== 'closing' || !closingMonthId || !supabase) return

    let active = true
    void loadMonthReconciliation(closingMonthId)
      .then((reconciliation) => {
        if (active) setMonthReconciliation(reconciliation)
      })
      .catch((loadError: unknown) => {
        if (active) {
          setMonthReconciliation(null)
          setClosingError(loadError instanceof Error ? loadError.message : 'Could not load month reconciliation.')
        }
      })
      .finally(() => {
        if (active) setClosingLoading(false)
      })

    return () => { active = false }
  }, [signedIn, role, view, closingMonthId])

  useEffect(() => {
    if (!signedIn || view !== 'account' || !financeMonthId || !supabase) return

    let active = true
    void loadAccountStatement(financeMonthId)
      .then((statement) => { if (active) setAccountStatement(statement) })
      .catch((loadError: unknown) => {
        if (active) setStatementError(loadError instanceof Error ? loadError.message : 'Could not load account statement.')
      })
      .finally(() => { if (active) setStatementLoading(false) })

    return () => { active = false }
  }, [signedIn, role, view, financeMonthId])

  useEffect(() => {
    if (!signedIn || role !== 'admin' || view !== 'loans' || !supabase) return

    let active = true
    void Promise.all([loadAdminSocietyBorrowings(), loadResidents()])
      .then(([loans, residentRows]) => {
        if (!active) return
        setLoanRecords(loans)
        setResidents(residentRows)
        setLoanResidentId((current) => residentRows.some((resident) => resident.id === current && resident.is_active)
          ? current
          : residentRows.find((resident) => resident.is_active)?.id ?? '')
      })
      .catch((loadError: unknown) => {
        if (active) setLoansError(loadError instanceof Error ? loadError.message : 'Could not load society borrowings.')
      })
      .finally(() => { if (active) setLoansLoading(false) })

    return () => { active = false }
  }, [signedIn, role, view])

  useEffect(() => {
    const client = supabase
    if (!client) return

    let active = true
    const restoreSession = async () => {
      try {
        const { data, error: sessionError } = await client.auth.getSession()
        if (!active) return
        if (sessionError) {
          setError(`Could not restore your session: ${sessionError.message}`)
          return
        }
        if (!data.session) return

        const profile = await loadProfile(data.session.user.id)
        if (!active) return
        setRole(profile.role)
        setProfileName(profile.name)
        setDashboardLoading(true)
        setSignedIn(true)
      } catch (profileError) {
        if (active) setError(profileError instanceof Error ? profileError.message : 'Could not restore your session.')
        await client.auth.signOut()
      } finally {
        if (active) setAuthChecking(false)
      }
    }

    void restoreSession()
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!session) setSignedIn(false)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    setError('')

    if (!isSupabaseConfigured || !supabase) {
      setSignedIn(true)
      return
    }

    const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password })
    if (authError) {
      setError(authError.message)
      return
    }

    try {
      const profile = await loadProfile(data.user.id)
      setRole(profile.role)
      setProfileName(profile.name)
      setSignedIn(true)
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : 'Could not load your profile.')
      await supabase.auth.signOut()
    }
  }

  async function loadNotificationPanel() {
    if (!supabase) return
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError) throw new Error(`Could not identify your account: ${userError.message}`)
    if (!user) throw new Error('You must be signed in to view notifications.')

    const [
      { data: notificationRows, error: notificationError },
      { data: preferences, error: preferencesError },
      { count, error: countError },
    ] = await Promise.all([
      supabase.from('notifications')
        .select('id, title, body, type, read_at, created_at')
        .eq('profile_id', user.id)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.from('notification_preferences')
        .select('push_enabled, maintenance_updates, payment_updates, society_updates, borrowing_updates, reminders')
        .eq('profile_id', user.id)
        .maybeSingle(),
      supabase.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('profile_id', user.id)
        .is('read_at', null),
    ])
    if (notificationError) throw new Error(`Could not load notifications: ${notificationError.message}`)
    if (preferencesError) throw new Error(`Could not load notification preferences: ${preferencesError.message}`)
    if (countError) throw new Error(`Could not load unread notification count: ${countError.message}`)

    setNotifications((notificationRows ?? []) as UserNotification[])
    setUnreadNotificationCount(count ?? 0)
    setNotificationPreferences({ ...defaultNotificationPreferences, ...(preferences ?? {}) })
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      const registration = await navigator.serviceWorker.ready
      setDevicePushEnabled(Boolean(await registration.pushManager.getSubscription()))
    } else {
      setDevicePushEnabled(false)
    }
  }

  async function saveNotificationPreferences(next: NotificationPreferences) {
    if (!supabase) {
      setNotificationError('Connect Supabase to save notification preferences.')
      return
    }
    setNotificationSaving(true)
    setNotificationError('')
    setNotificationNotice('')
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw new Error(`Could not identify your account: ${userError.message}`)
      if (!user) throw new Error('You must be signed in to update notification preferences.')
      const { error: saveError } = await supabase.from('notification_preferences').upsert({
        profile_id: user.id,
        ...next,
        updated_at: new Date().toISOString(),
      })
      if (saveError) throw new Error(`Could not save notification preferences: ${saveError.message}`)
      setNotificationPreferences(next)
      setNotificationNotice('Notification preferences saved.')
    } catch (saveError) {
      setNotificationError(saveError instanceof Error ? saveError.message : 'Could not save notification preferences.')
    } finally {
      setNotificationSaving(false)
    }
  }

  async function enablePushNotifications() {
    if (!supabase) {
      setNotificationError('Push notifications require a configured Supabase project.')
      return
    }
    if (!vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setNotificationError('Push notifications are not supported or are not configured for this app. In-app notifications will still work.')
      return
    }
    if (!window.isSecureContext) {
      setNotificationError('Push notifications require a secure HTTPS connection.')
      return
    }

    setNotificationSaving(true)
    setNotificationError('')
    setNotificationNotice('')
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setNotificationError(permission === 'denied'
          ? 'Notifications are blocked in browser settings. Allow them for this site to enable push.'
          : 'Notification permission was not granted.')
        return
      }

      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw new Error(`Could not identify your account: ${userError.message}`)
      if (!user) throw new Error('You must be signed in to enable notifications.')
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(vapidPublicKey),
        })
      const details = subscription.toJSON()
      if (!details.endpoint || !details.keys?.p256dh || !details.keys.auth) {
        throw new Error('The browser returned an incomplete push subscription.')
      }

      const { error: subscriptionError } = await supabase.from('push_subscriptions').upsert({
        profile_id: user.id,
        endpoint: details.endpoint,
        p256dh: details.keys.p256dh,
        auth: details.keys.auth,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'endpoint' })
      if (subscriptionError) throw new Error(`Could not save this device subscription: ${subscriptionError.message}`)
      setDevicePushEnabled(true)

      const nextPreferences = { ...notificationPreferences, push_enabled: true }
      const { error: preferenceError } = await supabase.from('notification_preferences').upsert({
        profile_id: user.id,
        ...nextPreferences,
        updated_at: new Date().toISOString(),
      })
      if (preferenceError) throw new Error(`Device registered, but preferences could not be saved: ${preferenceError.message}`)
      setNotificationPreferences(nextPreferences)

      const { error: testError } = await supabase.functions.invoke('send-push-notification', {
        body: { action: 'test' },
      })
      if (testError) {
        setNotificationError(`Push is enabled on this device, but the test message failed: ${testError.message}`)
      } else {
        setNotificationNotice('Push is enabled. A test notification was sent to this device.')
      }
    } catch (pushError) {
      setNotificationError(pushError instanceof Error ? pushError.message : 'Could not enable push notifications.')
    } finally {
      setNotificationSaving(false)
    }
  }

  async function disablePushNotifications() {
    if (!supabase || !('serviceWorker' in navigator) || !('PushManager' in window)) return
    setNotificationSaving(true)
    setNotificationError('')
    setNotificationNotice('')
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError) throw new Error(`Could not identify your account: ${userError.message}`)
      if (!user) throw new Error('You must be signed in to disable notifications.')

      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        const { error: deleteError } = await supabase.from('push_subscriptions')
          .delete()
          .eq('profile_id', user.id)
          .eq('endpoint', subscription.endpoint)
        if (deleteError) throw new Error(`Could not remove this device subscription: ${deleteError.message}`)
        await subscription.unsubscribe()
      }
      setDevicePushEnabled(false)

      const { count, error: countError } = await supabase.from('push_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('profile_id', user.id)
      if (countError) throw new Error(`Device disconnected, but other subscriptions could not be checked: ${countError.message}`)
      const nextPreferences = { ...notificationPreferences, push_enabled: (count ?? 0) > 0 }
      const { error: preferenceError } = await supabase.from('notification_preferences').upsert({
        profile_id: user.id,
        ...nextPreferences,
        updated_at: new Date().toISOString(),
      })
      if (preferenceError) throw new Error(`Device disconnected, but push preferences could not be saved: ${preferenceError.message}`)
      setNotificationPreferences(nextPreferences)
      setNotificationNotice(nextPreferences.push_enabled
        ? 'Push was disabled on this device. Your other registered devices remain enabled.'
        : 'Push notifications were disabled.')
    } catch (pushError) {
      setNotificationError(pushError instanceof Error ? pushError.message : 'Could not disable push notifications.')
    } finally {
      setNotificationSaving(false)
    }
  }

  async function sendTestNotification() {
    if (!supabase) return
    setNotificationSaving(true)
    setNotificationError('')
    setNotificationNotice('')
    try {
      const { error: testError } = await supabase.functions.invoke('send-push-notification', {
        body: { action: 'test' },
      })
      if (testError) setNotificationError(`Could not send test notification: ${testError.message}`)
      else setNotificationNotice('A test notification was sent to your registered devices.')
    } catch (testError) {
      setNotificationError(testError instanceof Error ? `Could not send test notification: ${testError.message}` : 'Could not send test notification.')
    } finally {
      setNotificationSaving(false)
    }
  }

  async function createMaintenanceReminders() {
    if (!supabase) return
    setReminderSending(true)
    setNotificationError('')
    setNotificationNotice('')
    try {
      const { data, error: reminderError } = await supabase.functions.invoke('send-push-notification', {
        body: {
          action: 'send_reminders',
          days_before_due: Number(reminderBeforeDays),
          days_after_due: Number(reminderAfterDays),
        },
      })
      if (reminderError) {
        setNotificationError(`Could not create maintenance reminders: ${reminderError.message}`)
      } else {
        const created = Number((data as { created?: number } | null)?.created ?? 0)
        setNotificationNotice(created ? `${created} maintenance reminder(s) created.` : 'No unpaid bills matched the selected reminder days.')
        try {
          await loadNotificationPanel()
        } catch (loadError) {
          setNotificationError(loadError instanceof Error ? loadError.message : 'Reminders were created, but the notification list could not be refreshed.')
        }
      }
    } catch (reminderError) {
      setNotificationError(reminderError instanceof Error ? reminderError.message : 'Could not create maintenance reminders.')
    } finally {
      setReminderSending(false)
    }
  }

  async function markNotificationRead(notification: UserNotification) {
    if (!supabase || notification.read_at) return
    const { data: { user }, error: userError } = await supabase.auth.getUser()
    if (userError || !user) {
      setNotificationError(userError?.message ?? 'You must be signed in to update notifications.')
      return
    }
    const readAt = new Date().toISOString()
    const { error: updateError } = await supabase.from('notifications')
      .update({ read_at: readAt })
      .eq('id', notification.id)
      .eq('profile_id', user.id)
    if (updateError) {
      setNotificationError(`Could not mark notification as read: ${updateError.message}`)
      return
    }
    setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: readAt } : item))
    setUnreadNotificationCount((count) => Math.max(0, count - 1))
  }

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    if (choice.outcome === 'accepted') setInstallPrompt(null)
  }

  function requireOnline(setError: (message: string) => void): boolean {
    if (navigator.onLine) return true
    setError('You are offline. Reconnect before saving changes.')
    return false
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut()
    setDashboard(null)
    setDashboardCharges([])
    setDashboardLoading(isSupabaseConfigured)
    setSignedIn(false)
  }

  async function submitMonthClose(event: React.FormEvent) {
    event.preventDefault()
    if (!requireOnline(setClosingError)) return
    if (!supabase || !closingMonthId || !monthReconciliation) {
      setClosingError('Select an accounting month and load its reconciliation first.')
      return
    }
    if (monthReconciliation.status !== 'open') {
      setClosingError('This accounting month is already closed.')
      return
    }
    if (monthReconciliation.missing_flat_bills > 0) {
      setClosingError('Generate maintenance bills for every active flat before closing this month.')
      return
    }
    if (monthReconciliation.cash_deficit > 0) {
      setClosingError('Record the funds received from an individual lender before closing a month with negative cash.')
      return
    }
    if (!window.confirm(`Close ${formatMonth(monthReconciliation.month)}? This will make its financial transactions read-only.`)) return

    setClosingSaving(true)
    setClosingError('')
    setClosingNotice('')
    const { error: closeError } = await supabase.rpc('close_accounting_month', {
      p_accounting_month_id: closingMonthId,
      p_closing_notes: closingNotes.trim() || null,
    })
    if (closeError) {
      setClosingError(closeError.message)
      setClosingSaving(false)
      return
    }

    setClosingNotes('')
    setDashboardLoading(true)
    try {
      const months = await loadAccountingMonths()
      const reconciliation = await loadMonthReconciliation(closingMonthId)
      setClosingMonths(months)
      setAccountingMonths(months)
      setFinanceMonths(months)
      setMonthReconciliation(reconciliation)
      setClosingNotice(`${formatMonth(reconciliation.month)} was closed with a balance of ${formatPKR(reconciliation.closing_balance)}.`)
    } catch (loadError) {
      setClosingError(loadError instanceof Error
        ? `Month closed, but the latest reconciliation could not be refreshed: ${loadError.message}`
        : 'Month closed, but the latest reconciliation could not be refreshed.')
    } finally {
      setClosingSaving(false)
    }
  }

  async function submitSocietyBorrowing(event: React.FormEvent) {
    event.preventDefault()
    if (!requireOnline(setLoansError)) return
    if (!supabase || !financeMonthId) {
      setLoansError('Select an accounting month first.')
      return
    }
    const month = financeMonths.find((row) => row.id === financeMonthId)
    if (!month || month.status !== 'open') {
      setLoansError('Select an open accounting month to record borrowed funds.')
      return
    }
    if (!loanResidentId || Number(loanAmount) <= 0) {
      setLoansError('Select a lender and enter a positive amount.')
      return
    }

    setLoanSaving(true)
    setLoansError('')
    setLoansNotice('')
    const { error: saveError } = await supabase.rpc('admin_record_society_borrowing', {
      p_lender_profile_id: loanResidentId,
      p_accounting_month_id: financeMonthId,
      p_amount: Number(loanAmount),
      p_received_date: loanDate,
      p_notes: loanNotes.trim() || null,
    })
    if (saveError) {
      setLoansError(saveError.message)
      setLoanSaving(false)
      return
    }

    try {
      setLoanRecords(await loadAdminSocietyBorrowings())
      setLoanFormOpen(false)
      setLoanAmount('')
      setLoanNotes('')
      setLoansNotice('Borrowing recorded as society cash received and added to the ledger.')
    } catch (loadError) {
      setLoansError(loadError instanceof Error ? loadError.message : 'Borrowing recorded, but the list could not be refreshed.')
    } finally {
      setLoanSaving(false)
    }
  }

  async function submitLoanRepayment(event: React.FormEvent) {
    event.preventDefault()
    if (!requireOnline(setLoansError)) return
    if (!supabase || !financeMonthId || !repaymentLoanId) {
      setLoansError('Select a loan and accounting month first.')
      return
    }
    const month = financeMonths.find((row) => row.id === financeMonthId)
    const loan = loanRecords.find((row) => row.id === repaymentLoanId)
    if (!month || month.status !== 'open') {
      setLoansError('Select an open accounting month to record a repayment to the lender.')
      return
    }
    if (!loan || Number(repaymentAmount) <= 0 || Number(repaymentAmount) > loan.outstanding) {
      setLoansError('Enter a positive amount no greater than the amount owed to this lender.')
      return
    }

    setLoanSaving(true)
    setLoansError('')
    setLoansNotice('')
    const { error: saveError } = await supabase.rpc('admin_record_society_borrowing_repayment', {
      p_society_borrowing_id: repaymentLoanId,
      p_accounting_month_id: financeMonthId,
      p_amount: Number(repaymentAmount),
      p_payment_date: repaymentDate,
      p_notes: repaymentNotes.trim() || null,
    })
    if (saveError) {
      setLoansError(saveError.message)
      setLoanSaving(false)
      return
    }

    try {
      setLoanRecords(await loadAdminSocietyBorrowings())
      setRepaymentLoanId(null)
      setRepaymentAmount('')
      setRepaymentNotes('')
      setLoansNotice('Repayment to the lender recorded and added to the society ledger.')
    } catch (loadError) {
      setLoansError(loadError instanceof Error ? loadError.message : 'Repayment recorded, but the loan list could not be refreshed.')
    } finally {
      setLoanSaving(false)
    }
  }

  async function createAccountingMonth() {
    if (!requireOnline(setMaintenanceError)) return
    if (!supabase) {
      setMaintenanceError('Supabase is not configured.')
      return
    }
    if (!newMonthValue) {
      setMaintenanceError('Choose an accounting month first.')
      return
    }

    setMaintenanceError('')
    setMaintenanceNotice('')
    const { data, error: createError } = await supabase.rpc('admin_create_accounting_month', {
      p_month: `${newMonthValue}-01`,
    })
    if (createError) {
      setMaintenanceError(createError.message)
      return
    }

    const monthId = data as string
    try {
      const months = await loadAccountingMonths()
      setAccountingMonths(months)
      setSelectedMonthId(monthId)
      setDueDate(monthDateFor(`${newMonthValue}-01`, 5))
      setMaintenanceLoading(true)
      const createdMonth = months.find((month) => month.id === monthId)
      setMaintenanceNotice(createdMonth?.status === 'closed'
        ? `${formatMonth(createdMonth.month)} already exists and is closed.`
        : `Accounting month ${formatMonth(`${newMonthValue}-01`)} is ready.`)
    } catch (loadError) {
      setMaintenanceError(loadError instanceof Error ? loadError.message : 'Month was created, but the month list could not be refreshed.')
    }
  }

  async function generateMaintenanceBills() {
    if (!requireOnline(setMaintenanceError)) return
    if (!supabase || !selectedMonthId) return
    const month = accountingMonths.find((row) => row.id === selectedMonthId)
    if (!month || month.status !== 'open') {
      setMaintenanceError('Select an open accounting month to generate bills.')
      return
    }
    if (!dueDate) {
      setMaintenanceError('Choose a due date for the generated bills.')
      return
    }

    const alreadyBilled = new Set(maintenanceOverview.charges.map((charge) => charge.flat_id))
    const flatsToBill = maintenanceFlats.filter((flat) => !alreadyBilled.has(flat.id))
    if (flatsToBill.length === 0) {
      setMaintenanceNotice('All active flats already have a bill for this month.')
      return
    }
    const total = flatsToBill.reduce((sum, flat) => sum + flat.monthly_maintenance_amount, 0)
    const confirmed = window.confirm(
      `Generate ${flatsToBill.length} bills totaling ${formatPKR(total)} for ${formatMonth(month.month)}? Existing bills will not be duplicated.`,
    )
    if (!confirmed) return

    setMaintenanceError('')
    setMaintenanceNotice('')
    setMaintenanceLoading(true)
    const { data, error: generateError } = await supabase.rpc('admin_generate_maintenance_charges', {
      p_accounting_month_id: selectedMonthId,
      p_due_date: dueDate,
    })
    if (generateError) {
      setMaintenanceError(generateError.message)
      setMaintenanceLoading(false)
      return
    }

    try {
      const overview = await loadMaintenanceOverview(selectedMonthId)
      setMaintenanceOverview(overview)
      setMaintenanceNotice(`${Number(data)} maintenance bill${Number(data) === 1 ? '' : 's'} generated.`)
    } catch (loadError) {
      setMaintenanceError(loadError instanceof Error ? loadError.message : 'Bills generated, but could not reload the list.')
    } finally {
      setMaintenanceLoading(false)
    }
  }

  async function startPayment(charge: MaintenanceBill) {
    if (!accountingMonths.find((month) => month.id === selectedMonthId && month.status === 'open')) {
      setMaintenanceError('Payments can only be recorded in an open accounting month.')
      return
    }
    setMaintenanceError('')
    setPaymentTargetFlatId(charge.flat_id)
    setPaymentAllocations(maintenanceOverview.charges
      .filter((row) => row.flat_id === charge.flat_id)
      .map((row) => ({
        chargeId: row.id,
        amount: row.id === charge.id ? row.outstanding.toFixed(2) : '',
      })))
    setPaymentAmount(charge.outstanding.toFixed(2))
    const selectedMonth = accountingMonths.find((month) => month.id === selectedMonthId)
    const today = localDate()
    setPaymentDate(selectedMonth && today.slice(0, 7) === selectedMonth.month.slice(0, 7)
      ? today
      : monthDateFor(selectedMonth?.month ?? today, 1))
    setPaymentMethod('Cash')
    setPaymentReference('')
    setPaymentNotes('')
    setPaymentChargeOptions([])
    setPaymentChargesLoading(true)
    setPaymentFormOpen(true)

    try {
      const charges = await loadFlatOutstandingCharges(charge.flat_id)
      setPaymentChargeOptions(charges)
      setPaymentAllocations(charges.map((row) => ({
        chargeId: row.id,
        amount: row.id === charge.id ? row.outstanding.toFixed(2) : '',
      })))
    } catch (loadError) {
      setMaintenanceError(loadError instanceof Error ? loadError.message : 'Could not load outstanding bills.')
    } finally {
      setPaymentChargesLoading(false)
    }
  }

  async function submitPayment(event: React.FormEvent) {
    event.preventDefault()
    if (!requireOnline(setMaintenanceError)) return
    if (!supabase || !selectedMonthId) return

    const amount = Number(paymentAmount)
    const allocations = paymentAllocations
      .map((allocation) => ({ charge_id: allocation.chargeId, amount: Number(allocation.amount) }))
      .filter((allocation) => Number.isFinite(allocation.amount) && allocation.amount > 0)
    const allocatedAmount = allocations.reduce((sum, allocation) => sum + allocation.amount, 0)

    if (!paymentTargetFlatId || !Number.isFinite(amount) || amount <= 0) {
      setMaintenanceError('Enter a valid payment amount.')
      return
    }
    if (allocatedAmount > amount) {
      setMaintenanceError('Allocated amount cannot exceed the payment received.')
      return
    }
    if (!paymentDate || !paymentMethod.trim()) {
      setMaintenanceError('Payment date and payment method are required.')
      return
    }

    setPaymentSaving(true)
    setMaintenanceError('')
    setMaintenanceNotice('')
    const { error: paymentError } = await supabase.rpc('admin_record_maintenance_payment', {
      p_flat_id: paymentTargetFlatId,
      p_accounting_month_id: selectedMonthId,
      p_amount: amount,
      p_payment_date: paymentDate,
      p_payment_method: paymentMethod,
      p_reference: paymentReference || null,
      p_notes: paymentNotes || null,
      p_allocations: allocations,
    })
    if (paymentError) {
      setMaintenanceError(paymentError.message)
      setPaymentSaving(false)
      return
    }

    try {
      const overview = await loadMaintenanceOverview(selectedMonthId)
      setMaintenanceOverview(overview)
      setMaintenanceNotice('Payment recorded successfully.')
      setPaymentFormOpen(false)
    } catch (loadError) {
      setMaintenanceError(loadError instanceof Error ? loadError.message : 'Payment recorded, but the list could not be refreshed.')
    } finally {
      setPaymentSaving(false)
    }
  }

  function startCreateHead() {
    setEditingHeadId(null)
    setHeadForm({ name: '', description: '', accountNumber: '', isActive: true })
    setExpenseError('')
    setExpenseNotice('')
    setHeadFormOpen(true)
  }

  function startEditHead(head: ExpenseHead) {
    setEditingHeadId(head.id)
    setHeadForm({
      name: head.name,
      description: head.description ?? '',
      accountNumber: getAccountNumber(head.details),
      isActive: head.is_active,
    })
    setExpenseError('')
    setExpenseNotice('')
    setHeadFormOpen(true)
  }

  async function submitExpenseHead(event: React.FormEvent) {
    event.preventDefault()
    if (!requireOnline(setExpenseError)) return
    if (!supabase) {
      setExpenseError('Supabase is not configured.')
      return
    }

    if (!headForm.name.trim()) {
      setExpenseError('Expense category name is required.')
      return
    }

    const details = editingHeadId
      ? { ...(expenseOverview.expense_heads.find((head) => head.id === editingHeadId)?.details ?? {}) }
      : {}
    if (headForm.accountNumber.trim()) {
      details.account_number = headForm.accountNumber.trim()
    } else {
      delete details.account_number
    }

    setExpenseSaving(true)
    setExpenseError('')
    setExpenseNotice('')
    const { error: saveError } = await supabase.rpc('admin_save_expense_head', {
      p_expense_head_id: editingHeadId,
      p_name: headForm.name.trim(),
      p_description: headForm.description.trim() || null,
      p_details: details,
      p_is_active: headForm.isActive,
    })
    if (saveError) {
      setExpenseError(saveError.message)
      setExpenseSaving(false)
      return
    }

    try {
      const overview = await loadExpenseOverview(expenseMonthId || null)
      setExpenseOverview(overview)
      setHeadFormOpen(false)
      setExpenseNotice(editingHeadId ? 'Expense category updated.' : 'Expense category created.')
    } catch (loadError) {
      setExpenseError(loadError instanceof Error ? loadError.message : 'Expense category saved, but could not reload expense data.')
    } finally {
      setExpenseSaving(false)
    }
  }

  function startCreateExpense() {
    const openMonth = expenseMonths.find((month) => month.id === expenseMonthId && month.status === 'open')
    if (!openMonth) {
      setExpenseError('Choose an open accounting month before recording an expense.')
      return
    }
    const firstHead = expenseOverview.expense_heads.find((head) => head.is_active)
    setExpenseForm({
      headId: firstHead?.id ?? '',
      amount: '',
      date: localDate().slice(0, 7) === openMonth.month.slice(0, 7)
        ? localDate()
        : monthDateFor(openMonth.month, 1),
      description: '',
      reference: '',
    })
    setExpenseAttachment(null)
    setExpenseError('')
    setExpenseNotice('')
    setExpenseFormOpen(true)
  }

  async function submitExpense(event: React.FormEvent) {
    event.preventDefault()
    if (!requireOnline(setExpenseError)) return
    if (!supabase || !expenseMonthId) return

    const month = expenseMonths.find((row) => row.id === expenseMonthId)
    const amount = Number(expenseForm.amount)
    if (!month || month.status !== 'open') {
      setExpenseError('Expenses can only be recorded in an open accounting month.')
      return
    }
    if (!expenseForm.headId || !Number.isFinite(amount) || amount <= 0 || !expenseForm.description.trim()) {
      setExpenseError('Choose a category, enter a positive amount, and provide a description.')
      return
    }
    const expenseDate = new Date(`${expenseForm.date}T00:00:00`)
    const selectedMonth = new Date(`${month.month}T00:00:00`)
    if (
      Number.isNaN(expenseDate.valueOf())
      || expenseDate.getFullYear() !== selectedMonth.getFullYear()
      || expenseDate.getMonth() !== selectedMonth.getMonth()
    ) {
      setExpenseError('Expense date must fall within the selected accounting month.')
      return
    }
    if (expenseAttachment) {
      const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
      if (!allowedTypes.includes(expenseAttachment.type)) {
        setExpenseError('Receipt must be a PDF, JPEG, PNG, or WebP file.')
        return
      }
      if (expenseAttachment.size > 10 * 1024 * 1024) {
        setExpenseError('Receipt must be 10 MB or smaller.')
        return
      }
    }

    setExpenseSaving(true)
    setExpenseError('')
    setExpenseNotice('')
    let uploadedPath: string | null = null
    let expenseRecorded = false
    try {
      if (expenseAttachment) {
        const safeName = expenseAttachment.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${expenseMonthId}/${crypto.randomUUID()}_${safeName}`
        const { error: uploadError } = await supabase.storage
          .from('expense-receipts')
          .upload(uploadedPath, expenseAttachment, { contentType: expenseAttachment.type, upsert: false })
        if (uploadError) throw new Error(`Could not upload receipt: ${uploadError.message}`)
      }

      const { error: recordError } = await supabase.rpc('admin_record_expense', {
        p_accounting_month_id: expenseMonthId,
        p_expense_head_id: expenseForm.headId,
        p_amount: amount,
        p_expense_date: expenseForm.date,
        p_description: expenseForm.description.trim(),
        p_reference: expenseForm.reference.trim() || null,
        p_details: {},
        p_attachment_path: uploadedPath,
      })
      if (recordError) throw new Error(recordError.message)
      expenseRecorded = true

      try {
        const overview = await loadExpenseOverview(expenseMonthId)
        setExpenseOverview(overview)
      } catch (loadError) {
        throw new Error(`Expense recorded, but the list could not be refreshed: ${loadError instanceof Error ? loadError.message : 'Unknown error'}`)
      }
      setExpenseFormOpen(false)
      setExpenseNotice('Expense recorded and added to the society ledger.')
      setExpenseAttachment(null)
    } catch (saveError) {
      let message = saveError instanceof Error ? saveError.message : 'Could not record expense.'
      if (uploadedPath && !expenseRecorded) {
        const { error: cleanupError } = await supabase.storage.from('expense-receipts').remove([uploadedPath])
        if (cleanupError) message += ` Receipt cleanup also failed: ${cleanupError.message}`
      }
      setExpenseError(message)
    } finally {
      setExpenseSaving(false)
    }
  }

  async function openExpenseReceipt(path: string) {
    if (!supabase) return
    const receiptWindow = window.open('about:blank', '_blank')
    if (!receiptWindow) {
      setExpenseError('Allow pop-ups to open the receipt.')
      return
    }

    const { data, error: signedUrlError } = await supabase
      .storage
      .from('expense-receipts')
      .createSignedUrl(path, 60)
    if (signedUrlError) {
      receiptWindow.close()
      setExpenseError(`Could not open receipt: ${signedUrlError.message}`)
      return
    }
    receiptWindow.opener = null
    receiptWindow.location.href = data.signedUrl
  }

  const visibleExpenses = expenseOverview.expenses.filter(
    (expense) => !expenseCategoryFilter || expense.expense_head_id === expenseCategoryFilter,
  )

  function startResidentCreate() {
    setEditingResidentId(null)
    setResidentForm(emptyResidentForm)
    setResidentNotice('')
    setResidentsError('')
    setResidentFormOpen(true)
  }

  function startResidentEdit(resident: ResidentRecord) {
    setEditingResidentId(resident.id)
    setResidentForm({
      fullName: resident.full_name,
      email: '',
      password: '',
      confirmPassword: '',
      phone: resident.phone ?? '',
      flatNumber: resident.flat?.flat_number ?? '',
      floor: resident.flat?.floor ?? '',
      monthlyMaintenanceAmount: resident.flat?.monthly_maintenance_amount.toString() ?? '',
      isActive: resident.is_active,
      flatIsActive: resident.flat?.is_active ?? true,
    })
    setResidentNotice('')
    setResidentsError('')
    setResidentFormOpen(true)
  }

  async function submitResident(event: React.FormEvent) {
    event.preventDefault()
    if (!requireOnline(setResidentsError)) return
    if (!supabase) {
      setResidentsError('Supabase is not configured.')
      return
    }

    const maintenanceAmount = Number(residentForm.monthlyMaintenanceAmount)
    if (!residentForm.fullName.trim() || !residentForm.flatNumber.trim() || !Number.isFinite(maintenanceAmount) || maintenanceAmount < 0) {
      setResidentsError('Enter a resident name, flat number, and valid non-negative maintenance amount.')
      return
    }
    if (!editingResidentId && !residentForm.email.trim()) {
      setResidentsError('An email address is required to create a resident account.')
      return
    }
    if (!editingResidentId && residentForm.password.length < 8) {
      setResidentsError('Set a password with at least 8 characters.')
      return
    }
    if (!editingResidentId && residentForm.password !== residentForm.confirmPassword) {
      setResidentsError('The passwords do not match.')
      return
    }

    setResidentSaving(true)
    setResidentsError('')
    setResidentNotice('')
    try {
      if (editingResidentId) {
        const resident = residents.find((row) => row.id === editingResidentId)
        if (!resident) throw new Error('Resident record was not found.')

        const { error: updateError } = await supabase.rpc('admin_update_resident', {
          p_profile_id: editingResidentId,
          p_full_name: residentForm.fullName.trim(),
          p_phone: residentForm.phone.trim() || null,
          p_is_active: residentForm.isActive,
          p_flat_id: resident.flat?.id ?? null,
          p_flat_number: residentForm.flatNumber.trim(),
          p_floor: residentForm.floor.trim() || null,
          p_monthly_maintenance_amount: maintenanceAmount,
          p_flat_is_active: residentForm.flatIsActive,
        })
        if (updateError) throw new Error(updateError.message)
      } else {
        const { error: createError } = await supabase.functions.invoke('admin-create-resident', {
          body: {
            email: residentForm.email.trim(),
            password: residentForm.password,
            fullName: residentForm.fullName.trim(),
            phone: residentForm.phone.trim() || null,
            flatNumber: residentForm.flatNumber.trim(),
            floor: residentForm.floor.trim() || null,
            monthlyMaintenanceAmount: maintenanceAmount,
          },
        })
        if (createError) throw new Error(createError.message)
      }

      const updatedResidents = await loadResidents()
      setResidents(updatedResidents)
      setResidentFormOpen(false)
      setResidentForm(emptyResidentForm)
      setResidentNotice(editingResidentId ? 'Resident and flat details updated.' : 'Resident account created and flat assigned.')
      setEditingResidentId(null)
    } catch (saveError) {
      setResidentsError(saveError instanceof Error ? saveError.message : 'Could not save resident.')
    } finally {
      setResidentSaving(false)
    }
  }

  if (authChecking) {
    return (
      <main className="auth-loading" role="status" aria-live="polite">
        <div className="auth-loading-card">
          <div className="loading-spinner" />
          <Brand />
          <span>Checking your session…</span>
        </div>
      </main>
    )
  }

  if (!signedIn) {
    return (
      <main className="login-page">
        <section className="login-story">
          <Brand />
          <div className="story-copy">
            <span className="eyebrow">Transparent society accounting</span>
            <h1>Every payment.<br />Every expense.<br />Clearly accounted.</h1>
            <p>One shared view of your building's monthly finances, maintenance dues and society advances.</p>
          </div>
          <div className="story-foot">
            <span>PKR</span>
            <span>Monthly statements</span>
            <span>Secure access</span>
          </div>
        </section>

        <section className="login-panel">
          <form className="login-card" onSubmit={signIn}>
            <div className="mobile-brand"><Brand /></div>
            <span className="eyebrow">Welcome back</span>
            <h2>Sign in to your account</h2>
            <label>
              Email address
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password" />
            </label>
            {error && <div className="form-error">{error}</div>}
            {!isSupabaseConfigured && (
              <div className="demo-note">Supabase is not configured yet. Use Demo access below.</div>
            )}
            <button className="primary-button" type="submit">Sign in</button>
            {!isSupabaseConfigured && (
              <button className="demo-button" type="button" onClick={() => setSignedIn(true)}>
                Continue with demo access
              </button>
            )}
            <button className="forgot-button" type="button">Forgot password?</button>
          </form>
        </section>
      </main>
    )
  }

  const navItems = [
    { id: 'dashboard' as View, label: 'Overview', icon: LayoutDashboard },
    { id: 'maintenance' as View, label: role === 'admin' ? 'Maintenance' : 'My maintenance', icon: ReceiptText, className: 'resident-nav-item' },
    { id: 'society' as View, label: 'Society finances', icon: CircleDollarSign, className: 'resident-nav-item' },
    { id: 'account' as View, label: 'Account statement', icon: WalletCards, className: 'resident-nav-item' },
  ]
  const adminNavItems = [
    { id: 'flats' as View, label: 'Flats & users', icon: Users },
    { id: 'expenses' as View, label: 'Expenses', icon: Wrench },
    { id: 'loans' as View, label: 'Society borrowing', icon: WalletCards },
    { id: 'closing' as View, label: 'Monthly closing', icon: CalendarDays },
    { id: 'settings' as View, label: 'Settings', icon: Settings },
  ]
  const pushSupported = isSupabaseConfigured
    && Boolean(vapidPublicKey)
    && window.isSecureContext
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav>
          <span className="nav-label">My account</span>
          {navItems.map((item) => (
            <button key={item.id} className={`${view === item.id ? 'active' : ''} ${item.className ?? ''}`} onClick={() => {
              if (item.id === 'dashboard') {
                setDashboardLoading(true)
                setDashboardError('')
              }
              if (item.id === 'maintenance') {
                setMaintenanceLoading(true)
                setMaintenanceError('')
                setMaintenanceNotice('')
              }
              if (item.id === 'society') {
                setExpenseLoading(true)
                setExpenseError('')
                setExpenseNotice('')
                setSocietySummaryLoading(role === 'admin')
                setSocietySummaryError('')
              }
              if (item.id === 'account') {
                setStatementLoading(true)
                setStatementError('')
              }
              setView(item.id)
            }}>
              <item.icon size={18} /><span>{item.label}</span>
            </button>
          ))}
          {role === 'admin' && (
            <>
              <span className="nav-label">Administration</span>
              {adminNavItems.map((item) => (
                <button key={item.id} className={view === item.id ? 'active admin-nav-item' : 'admin-nav-item'} onClick={() => {
                  if (item.id === 'dashboard') {
                    setDashboardLoading(true)
                    setDashboardError('')
                  }
                  if (item.id === 'maintenance') {
                    setMaintenanceLoading(true)
                    setMaintenanceError('')
                    setMaintenanceNotice('')
                  }
                  if (item.id === 'expenses') {
                    setExpenseLoading(true)
                    setExpenseError('')
                    setExpenseNotice('')
                  }
                  if (item.id === 'flats') {
                    setResidentsLoading(true)
                    setResidentsError('')
                  }
                  if (item.id === 'loans') {
                    setLoansLoading(true)
                    setLoansError('')
                    setLoansNotice('')
                  }
                  if (item.id === 'closing') {
                    setClosingLoading(Boolean(supabase))
                    setClosingError('')
                    setClosingNotice('')
                  }
                  setView(item.id)
                }}>
                  <item.icon size={18} /><span>{item.label}</span>
                </button>
              ))}
            </>
          )}
        </nav>
        <div className="sidebar-profile">
          <div className="avatar">{role === 'admin' ? 'SA' : 'FA'}</div>
          <div><strong>{profileName}</strong><span>{role === 'admin' ? 'Administrator' : dashboard?.flat_number ?? 'Resident'}</span></div>
          <button aria-label="Sign out" onClick={signOut}><LogOut size={17} /></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <span className="breadcrumb">{view === 'flats' || view === 'expenses' || view === 'loans' || view === 'closing' || view === 'settings' ? 'Administration' : 'My account'} / <strong>{viewLabels[view]}</strong></span>
            <h1>{viewLabels[view]}</h1>
          </div>
          <div className="top-actions">
            {!isSupabaseConfigured && (
              <div className="role-switch" aria-label="Demo role">
                <button className={role === 'resident' ? 'active' : ''} onClick={() => { setRole('resident'); setView('dashboard') }}>Resident</button>
                <button className={role === 'admin' ? 'active' : ''} onClick={() => { setRole('admin'); setView('dashboard') }}>Admin</button>
              </div>
            )}
            <div className="notification-menu">
              <button
                className="icon-button"
                aria-label={`Notifications${unreadNotificationCount ? `, ${unreadNotificationCount} unread` : ''}`}
                aria-expanded={notificationPanelOpen}
                onClick={() => {
                  setNotificationError('')
                  setNotificationNotice('')
                  setNotificationLoading(!notificationPanelOpen && Boolean(supabase))
                  setNotificationPanelOpen((open) => !open)
                }}
              >
                <Bell size={19} />
                {unreadNotificationCount > 0 && <span className="notification-count">{unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}</span>}
              </button>
              {notificationPanelOpen && (
                <section className="notification-panel" aria-label="Notifications and preferences">
                  <div className="notification-panel-heading">
                    <div><span className="month-label">Updates</span><h2>Notifications</h2></div>
                    <button type="button" aria-label="Close notifications" onClick={() => setNotificationPanelOpen(false)}>×</button>
                  </div>
                  {!isOnline && <div className="form-error">Connect to the internet to refresh notifications or save preferences.</div>}
                  {notificationError && <div className="form-error">{notificationError}</div>}
                  {notificationNotice && <div className="success-banner"><Check size={14} />{notificationNotice}</div>}
                  {notificationLoading ? (
                    <div className="empty-bills">Loading notifications…</div>
                  ) : supabase ? (
                    <div className="notification-list">
                      {notifications.length ? notifications.map((notification) => (
                        <button
                          className={`notification-item ${notification.read_at ? '' : 'unread'}`}
                          type="button"
                          key={notification.id}
                          onClick={() => void markNotificationRead(notification)}
                        >
                          <span><strong>{notification.title}</strong><small>{notification.body}</small><small>{new Date(notification.created_at).toLocaleString('en-PK')}</small></span>
                          {!notification.read_at && <i aria-label="Unread" />}
                        </button>
                      )) : <div className="empty-bills">No notifications yet. Account updates will appear here.</div>}
                    </div>
                  ) : (
                    <div className="empty-bills">Connect Supabase to receive account notifications.</div>
                  )}
                  <div className="notification-preferences">
                    <div className="notification-section-heading"><strong>Push notifications</strong><span>{notificationPreferences.push_enabled && devicePushEnabled ? 'This device is enabled' : 'Optional on this device'}</span></div>
                    {!isSupabaseConfigured ? (
                      <p className="form-help">Push notifications are available after connecting the app to Supabase.</p>
                    ) : !pushSupported ? (
                      <p className="form-help">{!window.isSecureContext ? 'Push requires HTTPS. In-app notifications remain available.' : 'Push is unavailable here or is not configured. In-app notifications remain available. On iPhone/iPad, install the app to your Home Screen and reopen it to enable push.'}</p>
                    ) : Notification.permission === 'denied' ? (
                      <p className="form-help">Notifications are blocked in browser settings. Allow them for this site, then return here to enable push.</p>
                    ) : !devicePushEnabled ? (
                      <button className="secondary-button" type="button" disabled={notificationSaving || !isOnline} onClick={() => void enablePushNotifications()}>
                        {notificationSaving ? 'Enabling…' : 'Enable on this device'}
                      </button>
                    ) : (
                      <div className="push-actions">
                        <button className="secondary-button" type="button" disabled={notificationSaving || !isOnline} onClick={() => void sendTestNotification()}>Send test</button>
                        <button className="cancel-button" type="button" disabled={notificationSaving || !isOnline} onClick={() => void disablePushNotifications()}>Disable on this device</button>
                      </div>
                    )}
                    {pushSupported && notificationPreferences.push_enabled && (
                      <div className="notification-category-list">
                        {([
                          ['maintenance_updates', 'New maintenance bills'],
                          ['payment_updates', 'Payments recorded'],
                          ['society_updates', 'Society month closed'],
                          ['borrowing_updates', 'Borrowing and repayments'],
                          ['reminders', 'Maintenance reminders'],
                        ] as const).map(([key, label]) => (
                          <label key={key}><input
                            type="checkbox"
                            checked={notificationPreferences[key]}
                            disabled={notificationSaving || !isOnline}
                            onChange={(event) => void saveNotificationPreferences({ ...notificationPreferences, [key]: event.target.checked })}
                          />{label}</label>
                        ))}
                      </div>
                    )}
                  </div>
                  {role === 'admin' && (
                    <div className="notification-preferences reminder-controls">
                      <div className="notification-section-heading"><strong>Maintenance reminders</strong><span>Notify residents with an unpaid bill</span></div>
                      <div className="reminder-fields">
                        <label>Days before due<input type="number" min="0" max="30" value={reminderBeforeDays} onChange={(event) => setReminderBeforeDays(event.target.value)} /></label>
                        <label>Days after due<input type="number" min="0" max="90" value={reminderAfterDays} onChange={(event) => setReminderAfterDays(event.target.value)} /></label>
                      </div>
                      <button className="secondary-button" type="button" disabled={reminderSending || notificationSaving || !isOnline} onClick={() => void createMaintenanceReminders()}>
                        {reminderSending ? 'Creating reminders…' : 'Send matching reminders'}
                      </button>
                    </div>
                  )}
                  <div className="notification-install">
                    <div className="notification-section-heading"><strong>Install the app</strong><span>{isInstalled ? 'Installed' : 'Optional'}</span></div>
                    {installPrompt ? (
                      <button className="secondary-button" type="button" onClick={() => void installApp()}>Install Society Maintenance</button>
                    ) : isInstalled ? (
                      <p className="form-help">The app is installed and opens in its own window.</p>
                    ) : (
                      <p className="form-help">Use your browser’s “Install app” or “Add to Home Screen” option. Some browsers only show it after using the app over HTTPS.</p>
                    )}
                  </div>
                </section>
              )}
            </div>
          </div>
        </header>

        {!isOnline && <div className="offline-banner" role="status">You’re offline. Saved records may be viewed where available, but changes cannot be submitted until you reconnect.</div>}

        {view === 'maintenance' && (
          <div className="content maintenance-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Maintenance</span><h2>{role === 'admin' ? 'Monthly billing & payments' : 'My bills & payments'}</h2><p>{role === 'admin' ? 'Create accounting months, generate flat bills, and record resident payments.' : 'Review your billed maintenance, payment history, and any unallocated credit.'}</p></div>
              {role === 'admin' && accountingMonths.some((month) => month.id === selectedMonthId && month.status === 'open') && (
                <div className="billing-actions">
                  <label>Due date<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
                  <button className="primary-button add-resident-button" type="button" disabled={maintenanceLoading || maintenanceFlats.length === 0} onClick={generateMaintenanceBills}><Plus size={16} /> Generate bills</button>
                </div>
              )}
            </section>

            {role === 'admin' && (
              <section className="panel month-tools">
                <div>
                  <label className="month-select-label">Accounting month
                    <select value={selectedMonthId} onChange={(event) => {
                      setSelectedMonthId(event.target.value)
                      setMaintenanceLoading(true)
                      setMaintenanceError('')
                      setMaintenanceNotice('')
                      const chosen = accountingMonths.find((month) => month.id === event.target.value)
                      if (chosen) setDueDate(monthDateFor(chosen.month, 5))
                    }}>
                      {accountingMonths.map((month) => <option key={month.id} value={month.id}>{formatMonth(month.month)} · {month.status}</option>)}
                      {!accountingMonths.length && <option value="">No accounting months</option>}
                    </select>
                  </label>
                  {accountingMonths.find((month) => month.id === selectedMonthId) && (
                    <span className="opening-balance">Opening balance: {formatPKR(accountingMonths.find((month) => month.id === selectedMonthId)!.opening_balance)}</span>
                  )}
                </div>
                <form className="create-month-form" onSubmit={(event) => { event.preventDefault(); void createAccountingMonth() }}>
                  <label>New month<input type="month" value={newMonthValue} onChange={(event) => setNewMonthValue(event.target.value)} required /></label>
                  <button type="submit" className="secondary-button" disabled={!newMonthValue}>Create month</button>
                </form>
              </section>
            )}

            {role === 'resident' && (
              <section className="panel month-tools">
                <label className="month-select-label">Statement month
                  <select value={selectedMonthId} onChange={(event) => {
                    setSelectedMonthId(event.target.value)
                    setMaintenanceLoading(true)
                    setMaintenanceError('')
                  }}>
                    {accountingMonths.map((month) => <option key={month.id} value={month.id}>{formatMonth(month.month)} · {month.status}</option>)}
                    {!accountingMonths.length && <option value="">No accounting months</option>}
                  </select>
                </label>
              </section>
            )}

            {maintenanceError && <div className="form-error page-error">{maintenanceError}</div>}
            {maintenanceNotice && <div className="success-banner"><Check size={16} />{maintenanceNotice}</div>}
            {maintenanceLoading && <div className="loading-banner">Loading maintenance records…</div>}

            <section className="panel billing-panel">
              <div className="panel-heading"><div><span>{accountingMonths.find((month) => month.id === selectedMonthId) ? formatMonth(accountingMonths.find((month) => month.id === selectedMonthId)!.month) : 'No accounting period'}</span><h3>Maintenance bills</h3></div><span className="resident-count">{maintenanceOverview.charges.length} bills</span></div>
              {maintenanceOverview.charges.length ? (
                <div className="billing-table">
                  <div className={`billing-table-head ${role === 'admin' ? '' : 'resident-billing-head'}`}><span>{role === 'admin' ? 'Flat' : 'Billing period'}</span><span>Due date</span><span>Bill</span><span>Paid</span><span>Outstanding</span><span>Status</span>{role === 'admin' && <span />}</div>
                  {maintenanceOverview.charges.map((charge) => (
                    <div className={`billing-table-row ${role === 'admin' ? '' : 'resident-billing-row'}`} key={charge.id}>
                      <strong>{role === 'admin' ? charge.flat_number : 'Monthly maintenance'}</strong>
                      <span>{new Date(`${charge.due_date}T00:00:00`).toLocaleDateString('en-PK')}</span>
                      <span>{formatPKR(charge.amount)}</span>
                      <span className="paid-amount">{formatPKR(charge.paid)}</span>
                      <strong>{formatPKR(charge.outstanding)}</strong>
                      <span className={`resident-status ${charge.outstanding <= 0 ? 'enabled' : charge.paid > 0 ? 'partial-status' : 'disabled'}`}>{charge.outstanding <= 0 ? 'Paid' : charge.paid > 0 ? 'Partially paid' : 'Unpaid'}</span>
                      {role === 'admin' && <button className="edit-resident-button" type="button" disabled={charge.outstanding <= 0 || !accountingMonths.some((month) => month.id === selectedMonthId && month.status === 'open')} onClick={() => startPayment(charge)}>Record payment</button>}
                    </div>
                  ))}
                </div>
              ) : <div className="empty-state"><ReceiptText size={25} /><strong>{selectedMonthId ? 'No bills generated' : 'No accounting month yet'}</strong><span>{role === 'admin' ? 'Create an accounting month and generate bills for active flats.' : 'Your bills will appear here after the administrator generates them.'}</span></div>}
            </section>

            <section className="panel billing-panel payments-panel">
              <div className="panel-heading"><div><span>Cash received</span><h3>{role === 'admin' ? 'Recorded payments' : 'Payment history'}</h3></div><span className="resident-count">{maintenanceOverview.payments.length} payments</span></div>
              {maintenanceOverview.payments.length ? (
                <div className="billing-table payments-table">
                  <div className={`billing-table-head ${role === 'admin' ? '' : 'resident-payment-head'}`}><span>{role === 'admin' ? 'Flat' : 'Payment date'}</span><span>Date</span><span>Method</span><span>Received</span><span>Allocated</span><span>Advance credit</span></div>
                  {maintenanceOverview.payments.map((payment) => (
                    <div className={`billing-table-row ${role === 'admin' ? '' : 'resident-payment-row'}`} key={payment.id}>
                      <strong>{role === 'admin' ? payment.flat_number : new Date(`${payment.payment_date}T00:00:00`).toLocaleDateString('en-PK')}</strong>
                      <span>{new Date(`${payment.payment_date}T00:00:00`).toLocaleDateString('en-PK')}</span>
                      <span>{payment.payment_method}{payment.reference ? <small className="table-subtext">{payment.reference}</small> : null}</span>
                      <span>{formatPKR(payment.amount)}</span>
                      <span className="paid-amount">{formatPKR(payment.allocated)}</span>
                      <strong>{formatPKR(payment.credit)}</strong>
                    </div>
                  ))}
                </div>
              ) : <div className="empty-bills">No payments recorded for this accounting month.</div>}
            </section>

            {paymentFormOpen && (
              <div className="form-backdrop" role="presentation" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !paymentSaving) setPaymentFormOpen(false)
              }}>
                <form className="resident-form payment-form" onSubmit={submitPayment} aria-labelledby="payment-form-title">
                  <div className="resident-form-heading"><div><span className="month-label">Maintenance collection</span><h3 id="payment-form-title">Record payment</h3></div><button type="button" aria-label="Close form" disabled={paymentSaving} onClick={() => setPaymentFormOpen(false)}>×</button></div>
                  <p className="form-help">Unallocated money remains a resident advance, not maintenance income.</p>
                  <div className="form-fields">
                    <label>Flat<input value={maintenanceOverview.charges.find((charge) => charge.flat_id === paymentTargetFlatId)?.flat_number ?? ''} readOnly /></label>
                    <label>Amount received (PKR)<input type="number" min="0.01" step="0.01" required value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} /></label>
                    <label>Payment date<input type="date" required value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} /></label>
                    <label>Payment method<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)}><option>Cash</option><option>Bank transfer</option><option>Cheque</option><option>Other</option></select></label>
                    <label>Reference (optional)<input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} /></label>
                    <label>Notes (optional)<input value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} /></label>
                  </div>
                  <div className="allocation-fields"><strong>Allocate to bills</strong>
                    {paymentChargesLoading ? <p>Loading this flat’s outstanding bills…</p> : paymentAllocations.map((allocation) => {
                      const charge = paymentChargeOptions.find((row) => row.id === allocation.chargeId)
                      if (!charge) return null
                      return <label key={allocation.chargeId}><span>{formatMonth(charge.month)} · Due {new Date(`${charge.due_date}T00:00:00`).toLocaleDateString('en-PK')} <small>{formatPKR(charge.outstanding)} outstanding</small></span><input aria-label={`Amount allocated to ${formatMonth(charge.month)} bill`} type="number" min="0" max={charge.outstanding} step="0.01" value={allocation.amount} onChange={(event) => setPaymentAllocations((current) => current.map((item) => item.chargeId === allocation.chargeId ? { ...item, amount: event.target.value } : item))} /></label>
                    })}
                    <p>Unallocated advance: {formatPKR(Math.max(0, Number(paymentAmount || 0) - paymentAllocations.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)))}</p>
                  </div>
                  {maintenanceError && <div className="form-error">{maintenanceError}</div>}
                  <div className="resident-form-actions"><button type="button" className="cancel-button" disabled={paymentSaving} onClick={() => setPaymentFormOpen(false)}>Cancel</button><button className="primary-button" disabled={paymentSaving || paymentChargesLoading} type="submit">{paymentSaving ? 'Saving…' : 'Confirm payment'}</button></div>
                </form>
              </div>
            )}
          </div>
        )}

        {view === 'expenses' && role === 'admin' && (
          <div className="content expense-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Administration</span><h2>Expense management</h2><p>Manage expense categories and record monthly society spending.</p></div>
              <div className="expense-heading-actions">
                <button className="secondary-button" type="button" onClick={startCreateHead}><Plus size={15} /> Expense category</button>
                <button className="primary-button add-resident-button" type="button" disabled={!expenseMonths.some((month) => month.id === expenseMonthId && month.status === 'open') || !expenseOverview.expense_heads.some((head) => head.is_active)} onClick={startCreateExpense}><Plus size={15} /> Record expense</button>
              </div>
            </section>

            {expenseError && <div className="form-error page-error">{expenseError}</div>}
            {expenseNotice && <div className="success-banner"><Check size={16} />{expenseNotice}</div>}
            {expenseLoading && <div className="loading-banner">Loading expense records…</div>}

            <section className="panel month-tools">
              <div>
                <label className="month-select-label">Accounting month
                  <select value={expenseMonthId} onChange={(event) => {
                    setExpenseMonthId(event.target.value)
                    setExpenseLoading(true)
                    setExpenseError('')
                    setExpenseNotice('')
                    setExpenseCategoryFilter('')
                  }}>
                    {expenseMonths.map((month) => <option key={month.id} value={month.id}>{formatMonth(month.month)} · {month.status}</option>)}
                    {!expenseMonths.length && <option value="">No accounting months</option>}
                  </select>
                </label>
                {expenseOverview.month_status && <span className={`resident-status ${expenseOverview.month_status === 'open' ? 'enabled' : 'disabled'}`}>{expenseOverview.month_status === 'open' ? 'Open for entries' : 'Closed'}</span>}
                <label className="month-select-label">Category
                  <select value={expenseCategoryFilter} onChange={(event) => setExpenseCategoryFilter(event.target.value)}>
                    <option value="">All categories</option>
                    {expenseOverview.expense_heads.map((head) => <option key={head.id} value={head.id}>{head.name}</option>)}
                  </select>
                </label>
              </div>
              <strong className="expense-total">Total: {formatPKR(visibleExpenses.reduce((total, item) => total + item.amount, 0))}</strong>
            </section>

            <section className="panel expense-head-panel">
              <div className="panel-heading"><div><span>Reusable categories</span><h3>Expense categories</h3></div><span className="resident-count">{expenseOverview.expense_heads.length} categories</span></div>
              {expenseOverview.expense_heads.length ? (
                <div className="expense-head-list">
                  {expenseOverview.expense_heads.map((head) => (
                    <article className={`expense-head-card ${head.is_active ? '' : 'inactive'}`} key={head.id}>
                      <div><strong>{head.name}</strong><span>{head.description || (head.is_active ? 'No description' : 'Inactive')}</span></div>
                      {getAccountNumber(head.details) && <span className="category-account-number">Account number: {getAccountNumber(head.details)}</span>}
                      <span className={`resident-status ${head.is_active ? 'enabled' : 'disabled'}`}>{head.is_active ? 'Active' : 'Inactive'}</span>
                      <button className="edit-resident-button" type="button" onClick={() => startEditHead(head)}><Pencil size={14} /> Edit</button>
                    </article>
                  ))}
                </div>
              ) : <div className="empty-bills">Create an expense category before recording a new expense.</div>}
            </section>

            <section className="panel billing-panel expenses-list-panel">
              <div className="panel-heading"><div><span>{expenseOverview.month ? formatMonth(expenseOverview.month) : 'No accounting period'}</span><h3>Monthly expenses</h3></div><span className="resident-count">{visibleExpenses.length} entries</span></div>
              {visibleExpenses.length ? (
                <div className="expense-list">
                  {visibleExpenses.map((expense) => (
                    <article className="expense-row" key={expense.id}>
                      <div className="expense-date"><strong>{new Date(`${expense.expense_date}T00:00:00`).toLocaleDateString('en-PK', { day: '2-digit' })}</strong><span>{new Date(`${expense.expense_date}T00:00:00`).toLocaleDateString('en-PK', { month: 'short' })}</span></div>
                      <div className="expense-description"><strong>{expense.description}</strong><span>{expense.expense_head_name}{expense.reference ? ` · Ref ${expense.reference}` : ''}</span></div>
                      {expense.attachment_path && <button className="receipt-link" type="button" onClick={() => void openExpenseReceipt(expense.attachment_path!)}>View receipt</button>}
                      <strong className="expense-amount">{formatPKR(expense.amount)}</strong>
                    </article>
                  ))}
                </div>
              ) : <div className="empty-state"><Wrench size={24} /><strong>No expenses recorded</strong><span>Expenses recorded for the selected month will appear here.</span></div>}
            </section>

            {headFormOpen && (
              <div className="form-backdrop" role="presentation" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !expenseSaving) setHeadFormOpen(false)
              }}>
                <form className="resident-form" onSubmit={submitExpenseHead} aria-labelledby="expense-head-form-title">
                  <div className="resident-form-heading"><div><span className="month-label">Expense category</span><h3 id="expense-head-form-title">{editingHeadId ? 'Edit category' : 'Create category'}</h3></div><button type="button" aria-label="Close form" disabled={expenseSaving} onClick={() => setHeadFormOpen(false)}>×</button></div>
                  <div className="form-fields">
                    <label>Name<input required value={headForm.name} onChange={(event) => setHeadForm({ ...headForm, name: event.target.value })} placeholder="Electricity, Security…" /></label>
                    <label>Description (optional)<input value={headForm.description} onChange={(event) => setHeadForm({ ...headForm, description: event.target.value })} /></label>
                    <label className="wide-field">Account number (optional)<input value={headForm.accountNumber} onChange={(event) => setHeadForm({ ...headForm, accountNumber: event.target.value })} /></label>
                  </div>
                  {editingHeadId && <div className="check-options"><label><input type="checkbox" checked={headForm.isActive} onChange={(event) => setHeadForm({ ...headForm, isActive: event.target.checked })} /> Category active</label></div>}
                  {expenseError && <div className="form-error">{expenseError}</div>}
                  <div className="resident-form-actions"><button type="button" className="cancel-button" disabled={expenseSaving} onClick={() => setHeadFormOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={expenseSaving}>{expenseSaving ? 'Saving…' : editingHeadId ? 'Save changes' : 'Create category'}</button></div>
                </form>
              </div>
            )}

            {expenseFormOpen && (
              <div className="form-backdrop" role="presentation" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !expenseSaving) setExpenseFormOpen(false)
              }}>
                <form className="resident-form" onSubmit={submitExpense} aria-labelledby="expense-form-title">
                  <div className="resident-form-heading"><div><span className="month-label">{expenseOverview.month ? formatMonth(expenseOverview.month) : 'Monthly expense'}</span><h3 id="expense-form-title">Record an expense</h3></div><button type="button" aria-label="Close form" disabled={expenseSaving} onClick={() => setExpenseFormOpen(false)}>×</button></div>
                  <p className="form-help">Recording this expense adds an outgoing entry to the society ledger. Expenses in closed months cannot be changed.</p>
                  <div className="form-fields">
                    <label>Expense category<select required value={expenseForm.headId} onChange={(event) => setExpenseForm({ ...expenseForm, headId: event.target.value })}><option value="">Select category</option>{expenseOverview.expense_heads.filter((head) => head.is_active).map((head) => <option key={head.id} value={head.id}>{head.name}</option>)}</select></label>
                    <label>Amount (PKR)<input type="number" min="0.01" step="0.01" required value={expenseForm.amount} onChange={(event) => setExpenseForm({ ...expenseForm, amount: event.target.value })} /></label>
                    <label>Expense date<input type="date" required value={expenseForm.date} onChange={(event) => setExpenseForm({ ...expenseForm, date: event.target.value })} /></label>
                    <label>Reference (optional)<input value={expenseForm.reference} onChange={(event) => setExpenseForm({ ...expenseForm, reference: event.target.value })} /></label>
                    <label className="wide-field">Description<input required value={expenseForm.description} onChange={(event) => setExpenseForm({ ...expenseForm, description: event.target.value })} placeholder="Describe this expense" /></label>
                    <label className="wide-field">Receipt attachment (optional)<input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setExpenseAttachment(event.target.files?.[0] ?? null)} /><small>PDF, JPEG, PNG, or WebP; maximum 10 MB.</small></label>
                  </div>
                  {expenseError && <div className="form-error">{expenseError}</div>}
                  <div className="resident-form-actions"><button type="button" className="cancel-button" disabled={expenseSaving} onClick={() => setExpenseFormOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={expenseSaving}>{expenseSaving ? 'Saving…' : 'Confirm expense'}</button></div>
                </form>
              </div>
            )}
          </div>
        )}

        {view === 'society' && (
          <div className="content expense-page society-finances-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Society finances</span><h2>{role === 'admin' ? 'Monthly cash & expenses' : 'Published expenses'}</h2><p>{role === 'admin' ? 'Review the society’s monthly cash position, collections, expenses and borrowing.' : 'Read-only monthly expense records for society transparency.'}</p></div>
            </section>
            {expenseError && <div className="form-error page-error">{expenseError}</div>}
            {expenseLoading && <div className="loading-banner">Loading society expenses…</div>}
            {societySummaryError && <div className="form-error page-error">{societySummaryError}</div>}
            <section className="panel month-tools">
              <div>
                  <label className="month-select-label">Accounting month
                  <select value={expenseMonthId} onChange={(event) => {
                    setExpenseMonthId(event.target.value)
                    setExpenseLoading(true)
                    setExpenseError('')
                    if (role === 'admin') {
                      setSocietySummaryLoading(true)
                      setSocietySummaryError('')
                      setSocietySummary(null)
                    }
                    setExpenseCategoryFilter('')
                  }}>
                    {expenseMonths.map((month) => <option key={month.id} value={month.id}>{formatMonth(month.month)} · {month.status}</option>)}
                    {!expenseMonths.length && <option value="">No accounting months</option>}
                  </select>
                </label>
                <label className="month-select-label">Category
                  <select value={expenseCategoryFilter} onChange={(event) => setExpenseCategoryFilter(event.target.value)}>
                    <option value="">All categories</option>
                    {expenseOverview.expense_heads.map((head) => <option key={head.id} value={head.id}>{head.name}</option>)}
                  </select>
                </label>
              </div>
              <strong className="expense-total">Expenses: {formatPKR(visibleExpenses.reduce((total, item) => total + item.amount, 0))}</strong>
            </section>
            {role === 'admin' && (
              societySummaryLoading
                ? <div className="loading-banner">Loading society cash summary…</div>
                : societySummary && (
                  <section className="closing-metrics society-finance-metrics">
                    <article className="metric-card"><span>Opening cash</span><strong>{formatPKR(societySummary.opening_balance)}</strong><div className="metric-foot"><span>Balance carried into month</span></div></article>
                    <article className="metric-card"><span>Maintenance collected</span><strong>{formatPKR(societySummary.maintenance_collected)}</strong><div className="metric-foot"><span>Payments received</span></div></article>
                    <article className="metric-card"><span>Other income</span><strong>{formatPKR(societySummary.other_income)}</strong><div className="metric-foot"><span>Non-maintenance receipts</span></div></article>
                    <article className="metric-card"><span>Expenses</span><strong>{formatPKR(societySummary.expenses)}</strong><div className="metric-foot"><span>Recorded cash outflow</span></div></article>
                    <article className="metric-card"><span>Borrowings received</span><strong>{formatPKR(societySummary.borrowings_received)}</strong><div className="metric-foot"><span>From individual lenders</span></div></article>
                    <article className="metric-card"><span>Borrowing repayments</span><strong>{formatPKR(societySummary.borrowing_repayments)}</strong><div className="metric-foot"><span>Paid back this month</span></div></article>
                    <article className="metric-card accent"><span>Closing cash balance</span><strong>{formatPKR(societySummary.closing_balance)}</strong><div className="metric-foot"><span>{societySummary.status === 'closed' ? 'Final closed balance' : 'Current ledger balance'}</span></div></article>
                    <article className="metric-card"><span>Owed to lenders</span><strong>{formatPKR(societySummary.society_owed)}</strong><div className="metric-foot"><span>Outstanding society liability</span></div></article>
                  </section>
                )
            )}
            <section className="panel billing-panel expenses-list-panel">
              <div className="panel-heading"><div><span>{expenseOverview.month ? formatMonth(expenseOverview.month) : 'No accounting period'}</span><h3>Society expenses</h3></div><span className="resident-count">{visibleExpenses.length} entries</span></div>
              {visibleExpenses.length ? (
                <div className="expense-list">
                  {visibleExpenses.map((expense) => (
                    <article className="expense-row" key={expense.id}>
                      <div className="expense-date"><strong>{new Date(`${expense.expense_date}T00:00:00`).toLocaleDateString('en-PK', { day: '2-digit' })}</strong><span>{new Date(`${expense.expense_date}T00:00:00`).toLocaleDateString('en-PK', { month: 'short' })}</span></div>
                      <div className="expense-description"><strong>{expense.description}</strong><span>{expense.expense_head_name}{expense.reference ? ` · Ref ${expense.reference}` : ''}</span></div>
                      {expense.attachment_path && <button className="receipt-link" type="button" onClick={() => void openExpenseReceipt(expense.attachment_path!)}>View receipt</button>}
                      <strong className="expense-amount">{formatPKR(expense.amount)}</strong>
                    </article>
                  ))}
                </div>
              ) : <div className="empty-state"><Wrench size={24} /><strong>No expenses published</strong><span>Expenses for this month will appear after the administrator records them.</span></div>}
            </section>
          </div>
        )}

        {view === 'settings' && role === 'admin' && (
          <div className="content settings-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Administration</span><h2>Society setup</h2><p>Current account-wide settings and shortcuts for administrative tasks.</p></div>
            </section>
            <section className="settings-grid">
              <article className="panel settings-card">
                <div className="panel-heading"><div><span>Identity</span><h3>Society details</h3></div><Building2 size={19} /></div>
                <div className="settings-value"><span>Society name</span><strong>North View Luxury Apartments</strong></div>
                <div className="settings-value"><span>Currency</span><strong>PKR · Pakistani Rupee</strong></div>
                <p className="form-help">Currency is fixed to PKR for this application.</p>
              </article>
              <article className="panel settings-card">
                <div className="panel-heading"><div><span>Billing</span><h3>Maintenance defaults</h3></div><ReceiptText size={19} /></div>
                <div className="settings-value"><span>Suggested due date</span><strong>5th of each month</strong></div>
                <p className="form-help">The due date is prefilled to the 5th when you create monthly bills, and can be changed before generating them.</p>
                <button className="secondary-button" type="button" onClick={() => {
                  setMaintenanceLoading(true)
                  setMaintenanceError('')
                  setMaintenanceNotice('')
                  setView('maintenance')
                }}>Open maintenance billing</button>
              </article>
              <article className="panel settings-card">
                <div className="panel-heading"><div><span>Access</span><h3>Administrator tasks</h3></div><Users size={19} /></div>
                <p className="form-help">Create and manage resident accounts, flat assignments and monthly maintenance amounts.</p>
                <button className="secondary-button" type="button" onClick={() => {
                  setResidentsLoading(true)
                  setResidentsError('')
                  setView('flats')
                }}>Manage residents and flats</button>
              </article>
            </section>
          </div>
        )}

        {view === 'flats' && role === 'admin' && (
          <div className="content admin-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Administration</span><h2>Flats & residents</h2><p>Manage resident access, flat assignments and monthly maintenance amounts.</p></div>
              <button className="primary-button add-resident-button" type="button" onClick={startResidentCreate}><Plus size={16} /> Add resident</button>
            </section>

            {residentNotice && <div className="success-banner"><Check size={16} />{residentNotice}</div>}
            {residentsError && <div className="form-error page-error">{residentsError}</div>}

            <section className="panel resident-list-panel">
              <div className="panel-heading"><div><span>Directory</span><h3>Residents and assigned flats</h3></div><span className="resident-count">{residents.length} residents</span></div>
              {residentsLoading ? (
                <div className="empty-state">Loading residents…</div>
              ) : residents.length === 0 ? (
                <div className="empty-state"><UserRound size={25} /><strong>No residents found</strong><span>Add a resident account and assign a flat.</span></div>
              ) : (
                <div className="resident-table">
                  <div className="resident-table-head"><span>Resident</span><span>Flat</span><span>Monthly maintenance</span><span>Status</span><span /></div>
                  {residents.map((resident) => (
                    <div className="resident-table-row" key={resident.id}>
                      <div className="resident-cell"><div className="resident-avatar">{resident.full_name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</div><div><strong>{resident.full_name}</strong><span>{resident.phone || 'No phone added'}</span></div></div>
                      <div className="resident-flat">{resident.flat?.flat_number ?? 'Unassigned'}{resident.flat?.floor ? <span>Floor {resident.flat.floor}</span> : null}</div>
                      <strong>{resident.flat ? formatPKR(resident.flat.monthly_maintenance_amount) : '—'}</strong>
                      <span className={`resident-status ${resident.is_active && resident.flat?.is_active ? 'enabled' : 'disabled'}`}>{resident.is_active && resident.flat?.is_active ? 'Active' : 'Inactive'}</span>
                      <button className="edit-resident-button" type="button" onClick={() => startResidentEdit(resident)} aria-label={`Edit ${resident.full_name}`}><Pencil size={15} /> Edit</button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {residentFormOpen && (
              <div className="form-backdrop" role="presentation" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !residentSaving) setResidentFormOpen(false)
              }}>
                <form className="resident-form" onSubmit={submitResident} aria-labelledby="resident-form-title">
                  <div className="resident-form-heading"><div><span className="month-label">{editingResidentId ? 'Edit record' : 'New resident'}</span><h3 id="resident-form-title">{editingResidentId ? 'Edit resident' : 'Create resident account'}</h3></div><button type="button" aria-label="Close form" disabled={residentSaving} onClick={() => setResidentFormOpen(false)}>×</button></div>
                  {!editingResidentId && <p className="form-help">Set a temporary password of at least 8 characters. Share the login credentials securely with the resident.</p>}
                  <div className="form-fields">
                    {!editingResidentId && <label>Email address<input type="email" required autoComplete="email" value={residentForm.email} onChange={(event) => setResidentForm({ ...residentForm, email: event.target.value })} /></label>}
                    {!editingResidentId && <label>Password<input type="password" required minLength={8} autoComplete="new-password" value={residentForm.password} onChange={(event) => setResidentForm({ ...residentForm, password: event.target.value })} /></label>}
                    {!editingResidentId && <label>Confirm password<input type="password" required minLength={8} autoComplete="new-password" value={residentForm.confirmPassword} onChange={(event) => setResidentForm({ ...residentForm, confirmPassword: event.target.value })} /></label>}
                    <label>Full name<input required value={residentForm.fullName} onChange={(event) => setResidentForm({ ...residentForm, fullName: event.target.value })} /></label>
                    <label>Phone (optional)<input type="tel" value={residentForm.phone} onChange={(event) => setResidentForm({ ...residentForm, phone: event.target.value })} /></label>
                    <label>Flat number<input required value={residentForm.flatNumber} onChange={(event) => setResidentForm({ ...residentForm, flatNumber: event.target.value })} /></label>
                    <label>Floor (optional)<input value={residentForm.floor} onChange={(event) => setResidentForm({ ...residentForm, floor: event.target.value })} /></label>
                    <label>Monthly maintenance (PKR)<input type="number" min="0" step="0.01" required value={residentForm.monthlyMaintenanceAmount} onChange={(event) => setResidentForm({ ...residentForm, monthlyMaintenanceAmount: event.target.value })} /></label>
                  </div>
                  {editingResidentId && (
                    <div className="check-options">
                      <label><input type="checkbox" checked={residentForm.isActive} onChange={(event) => setResidentForm({ ...residentForm, isActive: event.target.checked })} /> Account active</label>
                      <label><input type="checkbox" checked={residentForm.flatIsActive} onChange={(event) => setResidentForm({ ...residentForm, flatIsActive: event.target.checked })} /> Flat active</label>
                    </div>
                  )}
                  {residentsError && <div className="form-error">{residentsError}</div>}
                  <div className="resident-form-actions"><button type="button" className="cancel-button" disabled={residentSaving} onClick={() => setResidentFormOpen(false)}>Cancel</button><button className="primary-button" disabled={residentSaving} type="submit">{residentSaving ? 'Saving…' : editingResidentId ? 'Save changes' : 'Create account'}</button></div>
                </form>
              </div>
            )}
          </div>
        )}

        {view === 'account' && (
          <div className="content account-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Financial records</span><h2>{role === 'admin' ? 'Society account statement' : 'My account statement'}</h2><p>{role === 'admin' ? 'Review cash movements and the running society balance.' : 'Review maintenance charges, payments, funds lent to the society and repayments received. A negative balance means the society owes you.'}</p></div>
            </section>
            <section className="panel month-tools">
              <label className="month-select-label">Accounting month
                <select value={financeMonthId} onChange={(event) => {
                  setFinanceMonthId(event.target.value)
                  setStatementLoading(true)
                  setStatementError('')
                }}>
                  {financeMonths.map((month) => <option key={month.id} value={month.id}>{formatMonth(month.month)} · {month.status}</option>)}
                  {!financeMonths.length && <option value="">No accounting months</option>}
                </select>
              </label>
              {accountStatement && <strong className="statement-balance">{role === 'admin' ? 'Closing cash balance' : 'Closing account balance'}: {formatPKR(accountStatement.closing_balance)}</strong>}
            </section>
            {statementError && <div className="form-error page-error">{statementError}</div>}
            {statementLoading && <div className="loading-banner">Loading account statement…</div>}
            {accountStatement && (
              <section className="panel billing-panel statement-panel">
                <div className="panel-heading">
                  <div><span>{formatMonth(accountStatement.month)} · {accountStatement.month_status}</span><h3>Transactions</h3></div>
                  <span className="resident-count">Opening balance: {formatPKR(accountStatement.opening_balance)}</span>
                </div>
                {accountStatement.entries.length ? (
                  <div className="statement-table">
                    <div className="statement-table-head"><span>Date</span><span>Transaction</span><span>{role === 'admin' ? 'Cash movement' : 'Account movement'}</span><span>Balance</span></div>
                    {accountStatement.entries.map((entry) => (
                      <div className="statement-table-row" key={`${entry.entry_type}-${entry.id}`}>
                        <span>{new Date(`${entry.entry_date}T00:00:00`).toLocaleDateString('en-PK')}</span>
                        <div><strong>{entry.description}</strong><small>{entry.entry_type.replaceAll('_', ' ')}</small></div>
                        <strong className={entry.direction === 'in' ? 'statement-positive' : 'statement-negative'}>
                          {entry.direction === 'in' ? '+' : '−'}{formatPKR(entry.amount)}
                        </strong>
                        <strong>{formatPKR(entry.balance_after)}</strong>
                      </div>
                    ))}
                  </div>
                ) : <div className="empty-bills">No account transactions recorded for this month.</div>}
              </section>
            )}
          </div>
        )}

        {view === 'closing' && role === 'admin' && (
          <div className="content closing-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Administration</span><h2>Monthly reconciliation</h2><p>Review cash, maintenance, expenses and society borrowing before closing a month.</p></div>
            </section>

            <section className="panel month-tools">
              <label className="month-select-label">Accounting month
                <select value={closingMonthId} onChange={(event) => {
                  setClosingMonthId(event.target.value)
                  setClosingLoading(true)
                  setClosingError('')
                  setClosingNotice('')
                }}>
                  {closingMonths.map((month) => <option key={month.id} value={month.id}>{formatMonth(month.month)} · {month.status}</option>)}
                  {!closingMonths.length && <option value="">No accounting months</option>}
                </select>
              </label>
              {monthReconciliation && (
                <div className="closing-month-actions">
                  <span className={`resident-status ${monthReconciliation.status === 'open' ? 'enabled' : 'disabled'}`}>
                    {monthReconciliation.status === 'open' ? 'Open for entries' : 'Closed · read-only'}
                  </span>
                  <button className="secondary-button" type="button" onClick={() => {
                    setFinanceMonthId(closingMonthId)
                    setStatementLoading(true)
                    setStatementError('')
                    setView('account')
                  }}>View account statement</button>
                </div>
              )}
            </section>

            {closingError && <div className="form-error page-error">{closingError}</div>}
            {closingNotice && <div className="success-banner"><Check size={16} />{closingNotice}</div>}
            {closingLoading && <div className="loading-banner">Loading month reconciliation…</div>}
            {!closingLoading && closingMonths.length === 0 && !closingError && (
              <section className="panel empty-state"><CalendarDays size={24} /><strong>No accounting months yet</strong><span>Create the first month from Maintenance to begin tracking and closing accounts.</span></section>
            )}

            {monthReconciliation && !closingLoading && (
              <>
                <section className="closing-metrics">
                  <article className="metric-card"><span>Opening cash</span><strong>{formatPKR(monthReconciliation.opening_balance)}</strong><div className="metric-foot"><span>Balance carried into month</span></div></article>
                  <article className="metric-card"><span>Maintenance billed</span><strong>{formatPKR(monthReconciliation.maintenance_billed)}</strong><div className="metric-foot"><span>{monthReconciliation.billed_flats} flats billed</span></div></article>
                  <article className="metric-card"><span>Maintenance collected</span><strong>{formatPKR(monthReconciliation.maintenance_collected)}</strong><div className="metric-foot"><span>Payments received this month</span></div></article>
                  <article className="metric-card"><span>Maintenance outstanding</span><strong>{formatPKR(monthReconciliation.maintenance_outstanding)}</strong><div className="metric-foot"><span>Across this month's bills</span></div></article>
                  <article className="metric-card"><span>Other income</span><strong>{formatPKR(monthReconciliation.other_income)}</strong><div className="metric-foot"><span>Non-maintenance cash received</span></div></article>
                  <article className="metric-card"><span>Expenses</span><strong>{formatPKR(monthReconciliation.expenses)}</strong><div className="metric-foot"><span>Recorded cash outflow</span></div></article>
                  <article className="metric-card"><span>Funds borrowed</span><strong>{formatPKR(monthReconciliation.borrowings_received)}</strong><div className="metric-foot"><span>Received from individual lenders</span></div></article>
                  <article className="metric-card"><span>Repayments</span><strong>{formatPKR(monthReconciliation.borrowing_repayments)}</strong><div className="metric-foot"><span>Paid back to individual lenders</span></div></article>
                  <article className="metric-card accent"><span>Closing cash balance</span><strong>{formatPKR(monthReconciliation.closing_balance)}</strong><div className="metric-foot"><span>{monthReconciliation.status === 'closed' ? 'Final closed balance' : 'Calculated from the ledger'}</span></div></article>
                  <article className="metric-card"><span>Monthly net change</span><strong className={monthReconciliation.monthly_surplus_deficit < 0 ? 'statement-negative' : 'statement-positive'}>{formatPKR(monthReconciliation.monthly_surplus_deficit)}</strong><div className="metric-foot"><span>{monthReconciliation.monthly_surplus_deficit < 0 ? 'Deficit' : 'Surplus'}</span></div></article>
                  <article className="metric-card"><span>Owed to lenders</span><strong>{formatPKR(monthReconciliation.society_owed)}</strong><div className="metric-foot"><span>Outstanding society liability</span></div></article>
                </section>

                {monthReconciliation.missing_flat_bills > 0 && (
                  <section className="closing-warning">
                    <div><strong>{monthReconciliation.missing_flat_bills} active flat(s) still need a maintenance bill.</strong><span>Generate a bill for every active flat before closing this month.</span></div>
                    <button className="secondary-button" type="button" onClick={() => {
                      setSelectedMonthId(closingMonthId)
                      setMaintenanceLoading(true)
                      setMaintenanceError('')
                      setView('maintenance')
                    }}>Go to maintenance</button>
                  </section>
                )}
                {monthReconciliation.cash_deficit > 0 && (
                  <section className="closing-warning">
                    <div><strong>Cash deficit: {formatPKR(monthReconciliation.cash_deficit)}.</strong><span>Record funds received from an individual lender. Borrowing is never created automatically.</span></div>
                    <button className="secondary-button" type="button" onClick={() => {
                      setFinanceMonthId(closingMonthId)
                      setLoansLoading(true)
                      setLoansError('')
                      setLoansNotice('')
                      setView('loans')
                    }}>Record funds received</button>
                  </section>
                )}

                <section className="panel closing-actions">
                  <div className="panel-heading"><div><span>{formatMonth(monthReconciliation.month)}</span><h3>{monthReconciliation.status === 'open' ? 'Close accounting month' : 'Month closed'}</h3></div></div>
                  {monthReconciliation.status === 'open' ? (
                    <form onSubmit={submitMonthClose}>
                      <p className="form-help">Closing freezes this month's financial transactions. Its final cash balance will be carried forward when the next month is created.</p>
                      <label className="closing-notes-label">Closing notes (optional)<input value={closingNotes} onChange={(event) => setClosingNotes(event.target.value)} maxLength={1000} /></label>
                      <div className="resident-form-actions"><button className="primary-button" type="submit" disabled={closingSaving || monthReconciliation.missing_flat_bills > 0 || monthReconciliation.cash_deficit > 0}>{closingSaving ? 'Closing month…' : `Close ${formatMonth(monthReconciliation.month)}`}</button></div>
                    </form>
                  ) : (
                    <p className="form-help">This month is closed and its financial records are read-only. The closing cash balance is available as the next month's opening balance.</p>
                  )}
                </section>
              </>
            )}
          </div>
        )}

        {view === 'loans' && role === 'admin' && (
          <div className="content loans-page">
            <section className="admin-page-heading">
              <div><span className="month-label">Administration</span><h2>Society borrowing</h2><p>Record money individuals lend to the society and repayments made in the same or a later month. The society does not lend money to individuals.</p></div>
              <button className="primary-button add-resident-button" type="button" disabled={!financeMonths.some((month) => month.id === financeMonthId && month.status === 'open')} onClick={() => {
                const month = financeMonths.find((row) => row.id === financeMonthId)
                setLoanDate(month ? `${month.month.slice(0, 7)}-01` : localDate())
                setLoanFormOpen(true)
              }}><Plus size={16} /> Record funds received</button>
            </section>

            <section className="panel month-tools">
              <label className="month-select-label">Accounting month
                <select value={financeMonthId} onChange={(event) => {
                  setFinanceMonthId(event.target.value)
                  const month = financeMonths.find((row) => row.id === event.target.value)
                  if (month) {
                    setLoanDate(`${month.month.slice(0, 7)}-01`)
                    setRepaymentDate(`${month.month.slice(0, 7)}-01`)
                  }
                  setLoansError('')
                }}>
                  {financeMonths.map((month) => <option key={month.id} value={month.id}>{formatMonth(month.month)} · {month.status}</option>)}
                  {!financeMonths.length && <option value="">No accounting months</option>}
                </select>
              </label>
              {financeMonths.find((month) => month.id === financeMonthId) && <span className={`resident-status ${financeMonths.find((month) => month.id === financeMonthId)?.status === 'open' ? 'enabled' : 'disabled'}`}>{financeMonths.find((month) => month.id === financeMonthId)?.status === 'open' ? 'Open for entries' : 'Closed'}</span>}
            </section>

            {loansError && <div className="form-error page-error">{loansError}</div>}
            {loansNotice && <div className="success-banner"><Check size={16} />{loansNotice}</div>}
            {loansLoading && <div className="loading-banner">Loading society borrowing records…</div>}

            {loanFormOpen && (
              <section className="panel inline-finance-form">
                <form onSubmit={submitSocietyBorrowing}>
                  <div className="panel-heading"><div><span>New transaction</span><h3>Record funds lent to the society</h3></div></div>
                  <div className="form-fields">
                    <label>Lender<select required value={loanResidentId} onChange={(event) => setLoanResidentId(event.target.value)}><option value="">Select individual</option>{residents.filter((resident) => resident.is_active).map((resident) => <option key={resident.id} value={resident.id}>{resident.full_name}{resident.flat ? ` · ${resident.flat.flat_number}` : ''}</option>)}</select></label>
                    <label>Amount (PKR)<input type="number" min="0.01" step="0.01" required value={loanAmount} onChange={(event) => setLoanAmount(event.target.value)} /></label>
                    <label>Date funds received<input type="date" required value={loanDate} onChange={(event) => setLoanDate(event.target.value)} /></label>
                    <label>Notes (optional)<input value={loanNotes} onChange={(event) => setLoanNotes(event.target.value)} /></label>
                  </div>
                  <div className="resident-form-actions"><button type="button" className="cancel-button" disabled={loanSaving} onClick={() => setLoanFormOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={loanSaving}>{loanSaving ? 'Saving…' : 'Record funds received'}</button></div>
                </form>
              </section>
            )}

            <section className="panel billing-panel">
              <div className="panel-heading"><div><span>Outstanding society liability</span><h3>Borrowing history</h3></div><span className="resident-count">{loanRecords.length} borrowings</span></div>
              {loanRecords.length ? (
                <div className="loan-table">
                  <div className="loan-table-head"><span>Lender</span><span>Received</span><span>Funds received</span><span>Paid back</span><span>Still owed</span><span /></div>
                  {loanRecords.map((loan) => (
                    <div className="loan-table-row" key={loan.id}>
                      <strong>{loan.lender_name}<small>{loan.flat_number ?? 'Individual lender'}</small></strong>
                      <span>{new Date(`${loan.received_date}T00:00:00`).toLocaleDateString('en-PK')}<small>{formatMonth(loan.month)}</small></span>
                      <span>{formatPKR(loan.amount)}</span>
                      <span className="paid-amount">{formatPKR(loan.repaid)}</span>
                      <strong>{formatPKR(loan.outstanding)}</strong>
                      <button className="edit-resident-button" type="button" disabled={loan.outstanding <= 0 || !financeMonths.some((month) => month.id === financeMonthId && month.status === 'open')} onClick={() => {
                        const month = financeMonths.find((row) => row.id === financeMonthId)
                        setRepaymentLoanId(loan.id)
                        setRepaymentAmount('')
                        setRepaymentNotes('')
                        setRepaymentDate(month ? `${month.month.slice(0, 7)}-01` : localDate())
                      }}>Repay lender</button>
                    </div>
                  ))}
                </div>
              ) : <div className="empty-bills">No funds borrowed from individuals have been recorded.</div>}
            </section>

            {repaymentLoanId && (
              <div className="form-backdrop" role="presentation" onMouseDown={(event) => {
                if (event.target === event.currentTarget && !loanSaving) setRepaymentLoanId(null)
              }}>
                <form className="resident-form" onSubmit={submitLoanRepayment} aria-labelledby="repayment-form-title">
                  <div className="resident-form-heading"><div><span className="month-label">Society borrowing</span><h3 id="repayment-form-title">Repay lender</h3></div><button type="button" aria-label="Close form" disabled={loanSaving} onClick={() => setRepaymentLoanId(null)}>×</button></div>
                  <p className="form-help">Lender: {loanRecords.find((loan) => loan.id === repaymentLoanId)?.lender_name} · Society still owes {formatPKR(loanRecords.find((loan) => loan.id === repaymentLoanId)?.outstanding ?? 0)}</p>
                  <div className="form-fields">
                    <label>Amount (PKR)<input type="number" min="0.01" max={loanRecords.find((loan) => loan.id === repaymentLoanId)?.outstanding} step="0.01" required value={repaymentAmount} onChange={(event) => setRepaymentAmount(event.target.value)} /></label>
                    <label>Date repaid<input type="date" required value={repaymentDate} onChange={(event) => setRepaymentDate(event.target.value)} /></label>
                    <label className="wide-field">Notes (optional)<input value={repaymentNotes} onChange={(event) => setRepaymentNotes(event.target.value)} /></label>
                  </div>
                  <div className="resident-form-actions"><button type="button" className="cancel-button" disabled={loanSaving} onClick={() => setRepaymentLoanId(null)}>Cancel</button><button type="submit" className="primary-button" disabled={loanSaving}>{loanSaving ? 'Saving…' : 'Record repayment to lender'}</button></div>
                </form>
              </div>
            )}
          </div>
        )}

        {view === 'dashboard' && (
          <div className="content">
            <section className="welcome-row">
              <div><span className="month-label">{dashboard?.month ? formatMonth(dashboard.month) : 'Society accounts'}</span><h2>Good morning, {profileName.split(' ')[0]}</h2></div>
              <div className={`status-pill ${dashboard?.month_status === 'closed' ? 'closed' : ''}`}><span />{dashboard?.month_status ? `Month ${dashboard.month_status}` : 'No accounting month'}</div>
            </section>

            {dashboardError && <div className="form-error page-error">{dashboardError}</div>}
            {dashboardLoading && <div className="loading-banner">Loading financial summary…</div>}
            <section className="metric-grid">
              <article className="metric-card accent">
                <span>{role === 'admin' ? 'Maintenance billed this month' : 'Current month’s bill'}</span>
                <strong>{dashboard ? formatPKR(role === 'admin' ? dashboard.month_billed : dashboard.current_bill) : '—'}</strong>
                <div className="metric-foot"><span className="paid-dot">{dashboard?.month ? (role === 'admin' ? 'Current month' : dashboard.flat_number ?? 'No flat assigned') : 'No billing period'}</span><span>{dashboard?.month ? formatMonth(dashboard.month) : '—'}</span></div>
              </article>
              <article className="metric-card">
                <span>{role === 'admin' ? 'Total unpaid maintenance' : 'Your unpaid maintenance'}</span>
                <strong>{dashboard ? formatPKR(dashboard.unpaid_maintenance) : '—'}</strong>
                <div className="metric-foot"><span>{dashboard ? 'From recorded bills' : 'Loading records'}</span><ChevronRight size={15} /></div>
              </article>
              <article className="metric-card">
                <span>{role === 'admin' ? 'Society debt to residents' : 'Society owes you'}</span>
                <strong>{dashboard ? formatPKR(dashboard.society_owed) : '—'}</strong>
                <div className="metric-foot"><span>Outstanding advances</span><ChevronRight size={15} /></div>
              </article>
              <article className="metric-card">
                <span>Society cash balance</span>
                <strong>{dashboard?.society_balance !== null && dashboard ? formatPKR(dashboard.society_balance) : '—'}</strong>
                <div className="metric-foot"><span>Opening balance + ledger</span><ChevronRight size={15} /></div>
              </article>
            </section>

            <section className="dashboard-grid">
              <article className="panel charges-panel">
                <div className="panel-heading"><div><span>{dashboard?.month ? formatMonth(dashboard.month) : 'Maintenance'}</span><h3>Recent bills</h3></div><button onClick={() => setView('maintenance')}>View all <ChevronRight size={15} /></button></div>
                <div className="bill-list">
                  {dashboardCharges.length ? dashboardCharges.map((bill) => {
                    const paid = bill.allocated >= bill.amount
                    const partiallyPaid = bill.allocated > 0 && !paid
                    return <div className="bill-row" key={bill.id}>
                      <div className="bill-icon"><ReceiptText size={17} /></div>
                      <div className="bill-main"><strong>{role === 'admin' ? `${bill.flat_number} · ${formatPKR(bill.amount)}` : `Due ${new Date(`${bill.due_date}T00:00:00`).toLocaleDateString('en-PK')}`} </strong><span>Due {new Date(`${bill.due_date}T00:00:00`).toLocaleDateString('en-PK')}</span></div>
                      <div className="bill-amount"><strong>{formatPKR(bill.amount)}</strong><span className={`status ${paid ? 'paid' : 'partial'}`}>{paid ? 'Paid' : partiallyPaid ? 'Partially paid' : 'Unpaid'}</span></div>
                    </div>
                  }) : <div className="empty-bills">{dashboardLoading ? 'Loading bills…' : 'No maintenance bills recorded for this month.'}</div>}
                </div>
              </article>

              <article className="panel activity-panel">
                <div className="panel-heading"><div><span>{dashboard?.month ? formatMonth(dashboard.month) : 'No month selected'}</span><h3>Society summary</h3></div></div>
                <div className="summary-line"><span>Opening balance</span><strong>{dashboard ? formatPKR(dashboard.opening_balance ?? 0) : '—'}</strong></div>
                <div className="summary-line"><span>Maintenance payments received</span><strong className="positive">+{dashboard ? formatPKR(dashboard.collected) : '—'}</strong></div>
                <div className="summary-line"><span>Expenses recorded</span><strong className="negative">-{dashboard ? formatPKR(dashboard.expenses) : '—'}</strong></div>
                <div className="summary-line total"><span>Society cash balance</span><strong>{dashboard?.society_balance !== null && dashboard ? formatPKR(dashboard.society_balance) : '—'}</strong></div>
              </article>
            </section>
          </div>
        )}

        {view !== 'dashboard'
          && view !== 'maintenance'
          && view !== 'account'
          && !(view === 'flats' && role === 'admin')
          && !(view === 'expenses' && role === 'admin')
          && !(view === 'loans' && role === 'admin')
          && !(view === 'society')           && !(view === 'settings' && role === 'admin') && (
          <div className="content placeholder-page">
            <div className="placeholder-icon">
              {view === 'flats' ? <Users size={28} />
                : view === 'expenses' ? <Wrench size={28} />
                  : <Settings size={28} />}
            </div>
            <h2>{viewLabels[view]}</h2>
            <p>{view === 'flats'
              ? 'Flat and resident management will appear here once its database-backed workflows are implemented.'
              : view === 'expenses'
                ? 'Expense categories, monthly expenses and receipt records will appear here once expense workflows are implemented.'
                : 'This section is available to administrators.'}</p>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
