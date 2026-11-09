import { createFileRoute } from '@tanstack/react-router'
import {
  Component,
  type ErrorInfo,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react'

export const Route = createFileRoute('/')({
  component: AppRoot,
})

// Types
interface HomeItem {
  id: string
  name: string
  createdAt?: string
}

interface MemberItem {
  id: string
  homeId: string
  name: string
  position: number
}

interface ShareItem {
  id: string
  memberId: string
  memberName?: string
  amountCents: number
  paidAt: string | null
}

interface BillItem {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: ShareItem[]
}

interface BalanceItem {
  memberId: string
  name: string
  outstandingCents: number
}

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div style={styles.errorContainer}>
          <div style={styles.errorCard}>
            <h2 style={{ margin: '0 0 12px 0', color: '#b91c1c' }}>Something went wrong</h2>
            <p style={{ margin: '0 0 16px 0', color: '#4b5563' }}>
              {this.state.error?.message ||
                'An unexpected error occurred while rendering the page.'}
            </p>
            <button type="button" onClick={this.handleReset} style={styles.primaryButton}>
              Reload Application
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Resilient fetch helper with configurable timeout
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    return res
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100)
}

function AppRoot() {
  return (
    <ErrorBoundary>
      <BillSplitterApp />
    </ErrorBoundary>
  )
}

function BillSplitterApp() {
  const [homes, setHomes] = useState<HomeItem[]>([])
  const [selectedHomeId, setSelectedHomeId] = useState<string>('')
  const [members, setMembers] = useState<MemberItem[]>([])
  const [bills, setBills] = useState<BillItem[]>([])
  const [balances, setBalances] = useState<BalanceItem[]>([])

  const [loadingHomes, setLoadingHomes] = useState<boolean>(true)
  const [loadingDetails, setLoadingDetails] = useState<boolean>(false)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // Creation form states
  const [newHomeName, setNewHomeName] = useState('')
  const [newMemberName, setNewMemberName] = useState('')
  const [newBillTitle, setNewBillTitle] = useState('')
  const [newBillAmount, setNewBillAmount] = useState('')

  // In-flight tracking for payments
  const [payingShareId, setPayingShareId] = useState<string | null>(null)
  const [shareIdempotencyKeys, setShareIdempotencyKeys] = useState<
    Record<string, string | undefined>
  >({})
  const [submitting, setSubmitting] = useState<boolean>(false)

  // Load homes list
  const loadHomes = useCallback(async () => {
    setLoadingHomes(true)
    setGlobalError(null)
    try {
      const res = await fetchWithTimeout('/api/homes')
      const data = (await res.json()) as { homes?: HomeItem[]; error?: string }
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}: Failed to fetch homes`)
      }
      const list = data.homes ?? []
      setHomes(list)
      setSelectedHomeId((prev) => (prev ? prev : (list[0]?.id ?? '')))
    } catch (err: unknown) {
      setGlobalError(err instanceof Error ? err.message : 'Failed to connect to the server')
    } finally {
      setLoadingHomes(false)
    }
  }, [])

  useEffect(() => {
    loadHomes()
  }, [loadHomes])

  // Load details for selected home
  const loadHomeDetails = useCallback(async (homeId: string) => {
    if (!homeId) return
    setLoadingDetails(true)
    setActionError(null)
    try {
      const [membersRes, billsRes, balancesRes] = await Promise.all([
        fetchWithTimeout(`/api/homes/${homeId}/members`),
        fetchWithTimeout(`/api/homes/${homeId}/bills`),
        fetchWithTimeout(`/api/homes/${homeId}/balances`),
      ])

      const [membersData, billsData, balancesData] = (await Promise.all([
        membersRes.json(),
        billsRes.json(),
        balancesRes.json(),
      ])) as [
        { members?: MemberItem[]; error?: string },
        { bills?: BillItem[]; error?: string },
        { balances?: BalanceItem[]; error?: string },
      ]

      if (!membersRes.ok) throw new Error(membersData.error || 'Failed to load members')
      if (!billsRes.ok) throw new Error(billsData.error || 'Failed to load bills')
      if (!balancesRes.ok) throw new Error(balancesData.error || 'Failed to load balances')

      setMembers(membersData.members ?? [])
      setBills(billsData.bills ?? [])
      setBalances(balancesData.balances ?? [])
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to load home details')
    } finally {
      setLoadingDetails(false)
    }
  }, [])

  useEffect(() => {
    if (selectedHomeId) {
      loadHomeDetails(selectedHomeId)
    } else {
      setMembers([])
      setBills([])
      setBalances([])
    }
  }, [selectedHomeId, loadHomeDetails])

  // Create a new home
  const handleCreateHome = async (e: FormEvent) => {
    e.preventDefault()
    if (!newHomeName.trim()) return
    setSubmitting(true)
    setActionError(null)
    try {
      const res = await fetchWithTimeout('/api/homes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newHomeName.trim() }),
      })
      const data = (await res.json()) as { id: string; name: string; error?: string }
      if (!res.ok) throw new Error(data.error || 'Failed to create home')

      setNewHomeName('')
      setHomes((prev) => [data, ...prev])
      setSelectedHomeId(data.id)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Error creating home')
    } finally {
      setSubmitting(false)
    }
  }

  // Add a member
  const handleAddMember = async (e: FormEvent) => {
    e.preventDefault()
    if (!newMemberName.trim() || !selectedHomeId) return
    setSubmitting(true)
    setActionError(null)
    try {
      const res = await fetchWithTimeout(`/api/homes/${selectedHomeId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newMemberName.trim() }),
      })
      const data = (await res.json()) as MemberItem & { error?: string }
      if (!res.ok) throw new Error(data.error || 'Failed to add member')

      setNewMemberName('')
      await loadHomeDetails(selectedHomeId)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Error adding member')
    } finally {
      setSubmitting(false)
    }
  }

  // Create a bill
  const handleCreateBill = async (e: FormEvent) => {
    e.preventDefault()
    if (!newBillTitle.trim() || !newBillAmount || !selectedHomeId) return
    setActionError(null)

    const parsedDollars = Number.parseFloat(newBillAmount)
    if (Number.isNaN(parsedDollars) || parsedDollars <= 0) {
      setActionError('Please enter a valid bill amount greater than $0.00')
      return
    }

    const totalCents = Math.round(parsedDollars * 100)
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
      setActionError('Total amount must be a valid whole number of cents')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetchWithTimeout(`/api/homes/${selectedHomeId}/bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newBillTitle.trim(),
          totalCents,
        }),
      })
      const data = (await res.json()) as BillItem & { error?: string }
      if (!res.ok) throw new Error(data.error || 'Failed to create bill')

      setNewBillTitle('')
      setNewBillAmount('')
      await loadHomeDetails(selectedHomeId)
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Error creating bill')
    } finally {
      setSubmitting(false)
    }
  }

  // Pay a share
  const handlePayShare = async (billId: string, shareId: string) => {
    setPayingShareId(shareId)
    setActionError(null)

    // Reuse existing idempotency key for this share if retrying, otherwise create one
    let idempotencyKey = shareIdempotencyKeys[shareId]
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID()
      setShareIdempotencyKeys((prev) => ({ ...prev, [shareId]: idempotencyKey }))
    }

    try {
      const res = await fetchWithTimeout(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
      })
      const data = (await res.json()) as ShareItem & { error?: string }

      // Treat 409 as already paid: refetch true server state instead of scary error
      if (res.status === 409) {
        setShareIdempotencyKeys((prev) => {
          const next = { ...prev }
          delete next[shareId]
          return next
        })
        if (selectedHomeId) {
          await loadHomeDetails(selectedHomeId)
        }
        return
      }

      if (!res.ok) {
        throw new Error(data.error || `Payment failed (HTTP ${res.status})`)
      }

      // Success: clear the idempotency key for this share
      setShareIdempotencyKeys((prev) => {
        const next = { ...prev }
        delete next[shareId]
        return next
      })

      // Optimistically update the share in place to paid state
      setBills((prevBills) =>
        prevBills.map((b) => {
          if (b.id !== billId) return b
          return {
            ...b,
            shares: b.shares.map((s) => (s.id === shareId ? { ...s, paidAt: data.paidAt } : s)),
          }
        }),
      )

      // Refresh balances in background
      if (selectedHomeId) {
        const balRes = await fetchWithTimeout(`/api/homes/${selectedHomeId}/balances`)
        if (balRes.ok) {
          const balData = (await balRes.json()) as { balances?: BalanceItem[] }
          setBalances(balData.balances ?? [])
        }
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Payment request failed')
      // Refetch true server state: payment may have succeeded server-side before client failure/timeout
      if (selectedHomeId) {
        try {
          await loadHomeDetails(selectedHomeId)
        } catch {
          // preserve primary action error
        }
      }
    } finally {
      setPayingShareId(null)
    }
  }

  const selectedHome = homes.find((h) => h.id === selectedHomeId)

  return (
    <main style={styles.container}>
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={styles.logoBadge}>⊞</div>
          <div>
            <h1 style={styles.title}>Shared Bill Splitter</h1>
            <p style={styles.subtitle}>Fair expense distribution with Cloudflare D1</p>
          </div>
        </div>

        {/* Home Selector */}
        <div style={styles.homePicker}>
          <label htmlFor="home-select" style={styles.label}>
            Select Home:
          </label>
          <select
            id="home-select"
            value={selectedHomeId}
            onChange={(e) => setSelectedHomeId(e.target.value)}
            style={styles.select}
            disabled={homes.length === 0}
          >
            {homes.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Global Connection / Fetch Error */}
      {globalError && (
        <div style={styles.alertError}>
          <span>{globalError}</span>
          <button type="button" onClick={loadHomes} style={styles.retryButton}>
            Retry
          </button>
        </div>
      )}

      {/* Action / Mutation Error Banner */}
      {actionError && (
        <div style={styles.alertWarning}>
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} style={styles.dismissButton}>
            ✕
          </button>
        </div>
      )}

      {/* Loading Homes State */}
      {loadingHomes ? (
        <div style={styles.loadingBox}>
          <div style={styles.spinner} />
          <p style={{ marginTop: 12, color: '#6b7280' }}>Connecting to database...</p>
        </div>
      ) : homes.length === 0 ? (
        /* Empty Homes State */
        <section style={styles.emptyCard}>
          <h2 style={{ margin: '0 0 8px 0', fontSize: 20 }}>No homes created yet</h2>
          <p style={{ color: '#6b7280', margin: '0 0 20px 0' }}>
            Create your first home to start adding members and splitting bills.
          </p>
          <form
            onSubmit={handleCreateHome}
            style={{ display: 'flex', gap: 8, justifyContent: 'center' }}
          >
            <input
              type="text"
              placeholder="e.g. Flat 4B, Sunset Villa"
              value={newHomeName}
              onChange={(e) => setNewHomeName(e.target.value)}
              style={styles.input}
              required
            />
            <button type="submit" disabled={submitting} style={styles.primaryButton}>
              {submitting ? 'Creating...' : 'Create Home'}
            </button>
          </form>
        </section>
      ) : (
        /* Selected Home Dashboard */
        <div style={styles.grid}>
          {/* Left Column: Management & Balances */}
          <section style={styles.column}>
            {/* Home Details & Member Addition */}
            <div style={styles.card}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginBottom: 12,
                }}
              >
                <h2 style={styles.cardTitle}>{selectedHome?.name}</h2>
                <span style={styles.badge}>{members.length} members</span>
              </div>

              {/* Add New Member Form */}
              <form
                onSubmit={handleAddMember}
                style={{ display: 'flex', gap: 8, marginBottom: 16 }}
              >
                <input
                  type="text"
                  placeholder="New member name..."
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  style={styles.input}
                  required
                />
                <button type="submit" disabled={submitting} style={styles.secondaryButton}>
                  Add
                </button>
              </form>

              {/* Quick Home Creator */}
              <form onSubmit={handleCreateHome} style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  placeholder="Create another home..."
                  value={newHomeName}
                  onChange={(e) => setNewHomeName(e.target.value)}
                  style={styles.inputSmall}
                />
                <button
                  type="submit"
                  disabled={submitting || !newHomeName.trim()}
                  style={styles.ghostButton}
                >
                  + Home
                </button>
              </form>
            </div>

            {/* Outstanding Balances */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Outstanding Balances</h3>
              <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px 0' }}>
                Unpaid shares owed across all bills in this home.
              </p>

              {balances.length === 0 ? (
                <p style={styles.mutedText}>No members registered to calculate balances.</p>
              ) : (
                <ul style={styles.list}>
                  {balances.map((b) => (
                    <li key={b.memberId} style={styles.listItem}>
                      <span style={{ fontWeight: 500 }}>{b.name}</span>
                      <span
                        style={{
                          fontWeight: 600,
                          color: b.outstandingCents > 0 ? '#b91c1c' : '#059669',
                        }}
                      >
                        {formatCents(b.outstandingCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Create New Bill Form */}
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>Add New Bill</h3>
              {members.length === 0 ? (
                <p style={styles.mutedText}>
                  You must add at least one member before creating a bill.
                </p>
              ) : (
                <form
                  onSubmit={handleCreateBill}
                  style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
                >
                  <div>
                    <label htmlFor="bill-title" style={styles.inputLabel}>
                      Bill Title
                    </label>
                    <input
                      id="bill-title"
                      type="text"
                      placeholder="e.g. WiFi, Groceries, Rent"
                      value={newBillTitle}
                      onChange={(e) => setNewBillTitle(e.target.value)}
                      style={styles.input}
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="bill-amount" style={styles.inputLabel}>
                      Total Amount ($)
                    </label>
                    <input
                      id="bill-amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="e.g. 50.00"
                      value={newBillAmount}
                      onChange={(e) => setNewBillAmount(e.target.value)}
                      style={styles.input}
                      required
                    />
                  </div>

                  {newBillAmount && !Number.isNaN(Number.parseFloat(newBillAmount)) && (
                    <div style={styles.previewBox}>
                      <small style={{ color: '#4b5563' }}>
                        Split among {members.length} member{members.length > 1 ? 's' : ''}: ~
                        {formatCents(
                          Math.floor(
                            Math.round(Number.parseFloat(newBillAmount) * 100) / members.length,
                          ),
                        )}{' '}
                        each (remainders awarded in sequence)
                      </small>
                    </div>
                  )}

                  <button type="submit" disabled={submitting} style={styles.primaryButton}>
                    {submitting ? 'Creating...' : 'Split & Save Bill'}
                  </button>
                </form>
              )}
            </div>
          </section>

          {/* Right Column: Bills & Shares */}
          <section style={styles.columnWide}>
            <div style={styles.card}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 16,
                }}
              >
                <h2 style={styles.cardTitle}>Bills & Member Shares</h2>
                {selectedHomeId && (
                  <button
                    type="button"
                    onClick={() => loadHomeDetails(selectedHomeId)}
                    disabled={loadingDetails}
                    style={styles.ghostButton}
                  >
                    {loadingDetails ? 'Refreshing...' : '↻ Refresh'}
                  </button>
                )}
              </div>

              {loadingDetails ? (
                <div style={styles.loadingBox}>
                  <div style={styles.spinner} />
                  <p style={{ marginTop: 12, color: '#6b7280' }}>Loading bills & shares...</p>
                </div>
              ) : bills.length === 0 ? (
                <div style={styles.emptyStateContainer}>
                  <p style={{ color: '#6b7280', margin: '0 0 8px 0' }}>
                    No bills recorded for this home.
                  </p>
                  <span style={{ fontSize: 13, color: '#9ca3af' }}>
                    Use the form on the left to add a bill and split expenses.
                  </span>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  {bills.map((bill) => {
                    const allPaid = bill.shares.every((s) => s.paidAt !== null)
                    return (
                      <div key={bill.id} style={styles.billBox}>
                        <div style={styles.billHeader}>
                          <div>
                            <h3 style={{ margin: '0 0 4px 0', fontSize: 17, color: '#111827' }}>
                              {bill.title}
                            </h3>
                            <span style={{ fontSize: 13, color: '#6b7280' }}>
                              Total: <strong>{formatCents(bill.totalCents)}</strong>
                            </span>
                          </div>
                          <span style={allPaid ? styles.paidBadge : styles.unpaidBadge}>
                            {allPaid ? '✓ All Settled' : 'Unpaid Shares'}
                          </span>
                        </div>

                        {/* Shares Table */}
                        <div style={{ overflowX: 'auto' }}>
                          <table style={styles.table}>
                            <thead>
                              <tr style={styles.tableHeadRow}>
                                <th style={styles.th}>Member</th>
                                <th style={styles.th}>Share Amount</th>
                                <th style={styles.th}>Status</th>
                                <th style={{ ...styles.th, textAlign: 'right' }}>Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bill.shares.map((share) => {
                                const isPaid = share.paidAt !== null
                                const isPaying = payingShareId === share.id
                                return (
                                  <tr key={share.id} style={styles.tableRow}>
                                    <td style={styles.td}>{share.memberName || 'Member'}</td>
                                    <td style={{ ...styles.td, fontWeight: 500 }}>
                                      {formatCents(share.amountCents)}
                                    </td>
                                    <td style={styles.td}>
                                      {isPaid ? (
                                        <span style={styles.paidBadge}>
                                          Paid {new Date(share.paidAt ?? '').toLocaleDateString()}
                                        </span>
                                      ) : (
                                        <span style={styles.pendingBadge}>Pending</span>
                                      )}
                                    </td>
                                    <td style={{ ...styles.td, textAlign: 'right' }}>
                                      {isPaid ? (
                                        <span style={{ color: '#059669', fontSize: 13 }}>
                                          ✓ Complete
                                        </span>
                                      ) : (
                                        <button
                                          type="button"
                                          disabled={isPaying}
                                          onClick={() => handlePayShare(bill.id, share.id)}
                                          style={styles.payButton}
                                        >
                                          {isPaying ? 'Paying...' : 'Pay Share'}
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

// Inline Style Object adhering to Biome conventions
const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 1100,
    margin: '0 auto',
    padding: '24px 16px',
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: '#1f2937',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 16,
    paddingBottom: 20,
    marginBottom: 24,
    borderBottom: '1px solid #e5e7eb',
  },
  logoBadge: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#3b82f6',
    color: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    fontWeight: 'bold',
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    margin: 0,
    color: '#111827',
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
    margin: 0,
  },
  homePicker: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: 500,
    color: '#374151',
  },
  select: {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    backgroundColor: '#ffffff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 1fr) 2fr',
    gap: 20,
    alignItems: 'start',
  },
  column: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  columnWide: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    border: '1px solid #e5e7eb',
    padding: 20,
    boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
  },
  cardTitle: {
    margin: '0 0 12px 0',
    fontSize: 18,
    fontWeight: 600,
    color: '#111827',
  },
  emptyCard: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    border: '1px dashed #d1d5db',
    padding: 40,
    textAlign: 'center',
    maxWidth: 500,
    margin: '40px auto',
  },
  emptyStateContainer: {
    padding: '32px 16px',
    textAlign: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 8,
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 14,
  },
  inputSmall: {
    flex: 1,
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #e5e7eb',
    fontSize: 13,
  },
  inputLabel: {
    display: 'block',
    fontSize: 13,
    fontWeight: 500,
    marginBottom: 4,
    color: '#374151',
  },
  primaryButton: {
    padding: '8px 16px',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    fontWeight: 500,
    fontSize: 14,
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '8px 14px',
    backgroundColor: '#f3f4f6',
    color: '#374151',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontWeight: 500,
    fontSize: 14,
    cursor: 'pointer',
  },
  ghostButton: {
    padding: '6px 10px',
    backgroundColor: 'transparent',
    color: '#4b5563',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 12,
    cursor: 'pointer',
  },
  payButton: {
    padding: '6px 12px',
    backgroundColor: '#059669',
    color: '#ffffff',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },
  retryButton: {
    padding: '4px 10px',
    backgroundColor: '#b91c1c',
    color: '#ffffff',
    border: 'none',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
  },
  dismissButton: {
    background: 'none',
    border: 'none',
    fontSize: 14,
    color: '#9a3412',
    cursor: 'pointer',
  },
  alertError: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 14,
  },
  alertWarning: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    backgroundColor: '#ffedd5',
    color: '#9a3412',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 14,
  },
  badge: {
    fontSize: 12,
    backgroundColor: '#eff6ff',
    color: '#1d4ed8',
    padding: '2px 8px',
    borderRadius: 12,
    fontWeight: 500,
  },
  paidBadge: {
    fontSize: 12,
    backgroundColor: '#d1fae5',
    color: '#065f46',
    padding: '3px 8px',
    borderRadius: 12,
    fontWeight: 500,
  },
  unpaidBadge: {
    fontSize: 12,
    backgroundColor: '#fef3c7',
    color: '#92400e',
    padding: '3px 8px',
    borderRadius: 12,
    fontWeight: 500,
  },
  pendingBadge: {
    fontSize: 12,
    backgroundColor: '#f3f4f6',
    color: '#6b7280',
    padding: '3px 8px',
    borderRadius: 12,
    fontWeight: 500,
  },
  list: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  listItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: '#f9fafb',
    borderRadius: 6,
    fontSize: 14,
  },
  billBox: {
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    padding: 16,
    backgroundColor: '#ffffff',
  },
  billHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 14,
  },
  tableHeadRow: {
    borderBottom: '1px solid #e5e7eb',
  },
  th: {
    textAlign: 'left',
    padding: '8px 6px',
    color: '#6b7280',
    fontSize: 12,
    fontWeight: 600,
    textTransform: 'uppercase',
  },
  tableRow: {
    borderBottom: '1px solid #f3f4f6',
  },
  td: {
    padding: '10px 6px',
    color: '#1f2937',
  },
  previewBox: {
    padding: 8,
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
  },
  loadingBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  spinner: {
    width: 28,
    height: 28,
    border: '3px solid #e5e7eb',
    borderTopColor: '#2563eb',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  errorContainer: {
    padding: 32,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '60vh',
  },
  errorCard: {
    maxWidth: 500,
    padding: 24,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    border: '1px solid #fca5a5',
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
  },
  mutedText: {
    fontSize: 13,
    color: '#6b7280',
    margin: 0,
  },
}
