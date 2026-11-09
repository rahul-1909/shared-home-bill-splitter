import { describe, expect, it } from 'vitest'
import { type Balance, call, createBill, createHome, type Member, type Share } from './helpers'

describe('edge cases and defensive tests', () => {
  it('total 2 split across 3 members gives 1, 1, 0 (sum = total)', async () => {
    const { homeId } = await createHome(['Alice', 'Bob', 'Charlie'])

    const bill = await createBill(homeId, 2)

    expect(bill.status).toBe(201)
    expect(bill.body.shares.map((s) => s.amountCents)).toEqual([1, 1, 0])
    const sum = bill.body.shares.reduce((acc, s) => acc + s.amountCents, 0)
    expect(sum).toBe(2)
  })

  it.each([10.5, '1000', null, 0, -5])(
    'rejects invalid totalCents %j with 422',
    async (totalCents) => {
      const { homeId } = await createHome(['Alice'])

      const bill = await call('POST', `/api/homes/${homeId}/bills`, {
        body: { title: 'Invalid Total', totalCents },
      })

      expect(bill.status).toBe(422)
    },
  )

  it('rejects a bill on a home with no members with 422', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', {
      body: { name: 'Empty Home' },
    })

    const bill = await createBill(home.body.id, 500)

    expect(bill.status).toBe(422)
  })

  it('10 concurrent pay requests on one share with different keys give exactly one 200 and nine 409', async () => {
    const { homeId } = await createHome(['Alice', 'Bob'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('Share missing')

    // Launch 10 concurrent payments on the same share, each with a unique Idempotency-Key
    const promises = Array.from({ length: 10 }, () =>
      call<Share>('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }),
    )

    const results = await Promise.all(promises)
    const statuses = results.map((r) => r.status)

    const successes = statuses.filter((s) => s === 200)
    const conflicts = statuses.filter((s) => s === 409)

    expect(successes.length).toBe(1)
    expect(conflicts.length).toBe(9)
  })

  it('same idempotency key repeated returns 200 with identical body', async () => {
    const { homeId } = await createHome(['Alice'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('Share missing')

    const key = crypto.randomUUID()

    const first = await call<Share>('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {
      headers: { 'Idempotency-Key': key },
    })
    const second = await call<Share>('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {
      headers: { 'Idempotency-Key': key },
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
  })

  it('a share paid via the wrong billId returns 404', async () => {
    const { homeId } = await createHome(['Alice'])
    const bill1 = await createBill(homeId, 1000)
    const bill2 = await createBill(homeId, 500)
    const shareFromBill1 = bill1.body.shares[0]
    if (!shareFromBill1) throw new Error('Share missing')

    // Attempt to pay share of bill1 using bill2's ID
    const res = await call<Share>(
      'POST',
      `/api/bills/${bill2.body.id}/shares/${shareFromBill1.id}/pay`,
      {
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      },
    )

    expect(res.status).toBe(404)
  })

  it('missing Idempotency-Key returns 400', async () => {
    const { homeId } = await createHome(['Alice'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('Share missing')

    const res = await call('POST', `/api/bills/${bill.body.id}/shares/${share.id}/pay`, {})

    expect(res.status).toBe(400)
  })

  it('balances list members in add-order with 0 for fully paid members', async () => {
    const { homeId, members } = await createHome(['Asha', 'Ben', 'Chitra'])
    const bill = await createBill(homeId, 1500) // 500, 500, 500

    // Pay Asha's share
    const ashaShare = bill.body.shares[0]
    if (!ashaShare) throw new Error('Share missing')
    await call('POST', `/api/bills/${bill.body.id}/shares/${ashaShare.id}/pay`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })

    const balRes = await call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)

    expect(balRes.status).toBe(200)
    expect(balRes.body.balances).toEqual([
      { memberId: members[0]?.id, name: 'Asha', outstandingCents: 0 },
      { memberId: members[1]?.id, name: 'Ben', outstandingCents: 500 },
      { memberId: members[2]?.id, name: 'Chitra', outstandingCents: 500 },
    ])
  })

  it('10 concurrent member-adds all succeed with distinct positions', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', {
      body: { name: 'Concurrent Home' },
    })

    const memberNames = Array.from({ length: 10 }, (_, i) => `Member-${i + 1}`)

    const promises = memberNames.map((name) =>
      call<Member>('POST', `/api/homes/${home.body.id}/members`, {
        body: { name },
      }),
    )

    const responses = await Promise.all(promises)

    // Verify all 10 succeeded with 201
    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201))

    // Query members list to verify ordering and positions
    const listRes = await call<{ members: Array<{ id: string; name: string; position: number }> }>(
      'GET',
      `/api/homes/${home.body.id}/members`,
    )

    expect(listRes.status).toBe(200)
    const positions = listRes.body.members.map((m) => m.position)
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const uniquePositions = new Set(positions)
    expect(uniquePositions.size).toBe(10)
  })
})
