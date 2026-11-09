import { Hono } from 'hono'

type Bindings = Env

const app = new Hono<{ Bindings: Bindings }>()

// Global not-found handler returns structured JSON
app.notFound((c) => c.json({ error: 'Not found' }, 404))

// Global error handler ensures every uncaught error returns structured JSON
app.onError((err, c) => {
  console.error('Unhandled server error:', err)
  return c.json({ error: err instanceof Error ? err.message : 'Internal Server Error' }, 500)
})

// Safe JSON body parser that rejects malformed JSON
async function parseJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

// Health check endpoint
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// GET /api/homes - List homes for UI navigation
app.get('/api/homes', async (c) => {
  const result = await c.env.DB.prepare(
    'SELECT id, name, created_at AS createdAt FROM homes ORDER BY created_at DESC',
  ).all<{ id: string; name: string; createdAt: string }>()
  return c.json({ homes: result.results ?? [] }, 200)
})

// POST /api/homes - Create a new home
app.post('/api/homes', async (c) => {
  const body = await parseJson<{ name?: unknown }>(c.req.raw)
  if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'Home name is required' }, 422)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()

  return c.json({ id, name }, 201)
})

// GET /api/homes/:homeId - Get single home details
app.get('/api/homes/:homeId', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id, name FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string; name: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  return c.json(home, 200)
})

// GET /api/homes/:homeId/members - List members of a home in addition order
app.get('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const members = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, name, position FROM members WHERE home_id = ? ORDER BY position ASC',
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; name: string; position: number }>()

  return c.json({ members: members.results ?? [] }, 200)
})

// POST /api/homes/:homeId/members - Add a member to a home
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await parseJson<{ name?: unknown }>(c.req.raw)
  if (!body || typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'Member name is required' }, 422)
  }

  const id = crypto.randomUUID()
  const name = body.name.trim()

  const inserted = await c.env.DB.prepare(
    `INSERT INTO members (id, home_id, name, position)
     SELECT ?, ?, ?, COALESCE(MAX(position), 0) + 1
     FROM members
     WHERE home_id = ?
     RETURNING id, home_id AS homeId, name, position`,
  )
    .bind(id, homeId, name, homeId)
    .first<{ id: string; homeId: string; name: string; position: number }>()

  if (!inserted) {
    return c.json({ error: 'Failed to add member' }, 500)
  }

  return c.json({ id: inserted.id, homeId: inserted.homeId, name: inserted.name }, 201)
})

// GET /api/homes/:homeId/bills - List bills and their member shares
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const billsResult = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, title, total_cents AS totalCents FROM bills WHERE home_id = ? ORDER BY created_at DESC',
  )
    .bind(homeId)
    .all<{ id: string; homeId: string; title: string; totalCents: number }>()

  const bills = billsResult.results ?? []
  const billsWithShares = []

  for (const bill of bills) {
    const sharesResult = await c.env.DB.prepare(
      `SELECT 
         s.id, 
         s.member_id AS memberId, 
         m.name AS memberName,
         s.amount_cents AS amountCents, 
         s.paid_at AS paidAt 
       FROM shares s
       JOIN members m ON s.member_id = m.id
       WHERE s.bill_id = ?
       ORDER BY m.position ASC`,
    )
      .bind(bill.id)
      .all<{
        id: string
        memberId: string
        memberName: string
        amountCents: number
        paidAt: string | null
      }>()

    billsWithShares.push({
      ...bill,
      shares: sharesResult.results ?? [],
    })
  }

  return c.json({ bills: billsWithShares }, 200)
})

// POST /api/homes/:homeId/bills - Create and split a bill among home members
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const body = await parseJson<{ title?: unknown; totalCents?: unknown }>(c.req.raw)
  if (!body) {
    return c.json({ error: 'Invalid JSON request body' }, 422)
  }

  const { title, totalCents } = body

  if (typeof title !== 'string' || title.trim() === '') {
    return c.json({ error: 'Title is required' }, 422)
  }

  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive whole number' }, 422)
  }

  const membersResult = await c.env.DB.prepare(
    'SELECT id, name, position FROM members WHERE home_id = ? ORDER BY position ASC',
  )
    .bind(homeId)
    .all<{ id: string; name: string; position: number }>()

  const members = membersResult.results ?? []
  if (members.length === 0) {
    return c.json({ error: 'Home has no members' }, 422)
  }

  const n = members.length
  const base = Math.floor(totalCents / n)
  const rem = totalCents % n

  const billId = crypto.randomUUID()
  const cleanTitle = title.trim()

  type ShareResult = {
    id: string
    memberId: string
    amountCents: number
    paidAt: null
  }

  const shares: ShareResult[] = []
  const statements: D1PreparedStatement[] = []

  statements.push(
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, cleanTitle, totalCents),
  )

  for (let i = 0; i < members.length; i++) {
    const member = members[i]
    if (!member) continue
    const amountCents = i < rem ? base + 1 : base
    const shareId = crypto.randomUUID()

    shares.push({
      id: shareId,
      memberId: member.id,
      amountCents,
      paidAt: null,
    })

    statements.push(
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(shareId, billId, member.id, amountCents),
    )
  }

  await c.env.DB.batch(statements)

  return c.json(
    {
      id: billId,
      homeId,
      title: cleanTitle,
      totalCents,
      shares,
    },
    201,
  )
})

// POST /api/bills/:billId/shares/:shareId/pay - Atomically pay a share with idempotency
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')

  const idempotencyKey = c.req.header('Idempotency-Key')
  if (!idempotencyKey || idempotencyKey.trim() === '') {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const trimmedKey = idempotencyKey.trim()
  const now = new Date().toISOString()

  // Attempt atomic update: succeeds ONLY if share belongs to bill and is unpaid
  const updatedShare = await c.env.DB.prepare(
    `UPDATE shares 
     SET paid_at = ?, idempotency_key = ? 
     WHERE id = ? AND bill_id = ? AND paid_at IS NULL 
     RETURNING id, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt`,
  )
    .bind(now, trimmedKey, shareId, billId)
    .first<{ id: string; memberId: string; amountCents: number; paidAt: string }>()

  if (updatedShare) {
    return c.json(
      {
        id: updatedShare.id,
        memberId: updatedShare.memberId,
        amountCents: updatedShare.amountCents,
        paidAt: updatedShare.paidAt,
      },
      200,
    )
  }

  // If no row updated, inspect state to determine cause (404, idempotent replay 200, or 409)
  const existingShare = await c.env.DB.prepare(
    'SELECT id, bill_id AS billId, member_id AS memberId, amount_cents AS amountCents, paid_at AS paidAt, idempotency_key AS idempotencyKey FROM shares WHERE id = ?',
  )
    .bind(shareId)
    .first<{
      id: string
      billId: string
      memberId: string
      amountCents: number
      paidAt: string | null
      idempotencyKey: string | null
    }>()

  if (!existingShare || existingShare.billId !== billId) {
    return c.json({ error: 'Bill or share not found' }, 404)
  }

  if (existingShare.idempotencyKey === trimmedKey) {
    return c.json(
      {
        id: existingShare.id,
        memberId: existingShare.memberId,
        amountCents: existingShare.amountCents,
        paidAt: existingShare.paidAt,
      },
      200,
    )
  }

  return c.json({ error: 'Share already paid with a different idempotency key' }, 409)
})

// GET /api/homes/:homeId/balances - Return outstanding balances per member
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?')
    .bind(homeId)
    .first<{ id: string }>()

  if (!home) {
    return c.json({ error: 'Home not found' }, 404)
  }

  const balancesResult = await c.env.DB.prepare(
    `SELECT 
       m.id AS memberId,
       m.name AS name,
       COALESCE((
         SELECT SUM(s.amount_cents)
         FROM shares s
         JOIN bills b ON s.bill_id = b.id
         WHERE s.member_id = m.id 
           AND b.home_id = m.home_id 
           AND s.paid_at IS NULL
       ), 0) AS outstandingCents
     FROM members m
     WHERE m.home_id = ?
     ORDER BY m.position ASC`,
  )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: balancesResult.results ?? [] }, 200)
})

export default app
