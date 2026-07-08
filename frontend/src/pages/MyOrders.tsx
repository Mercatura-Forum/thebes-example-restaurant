import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import {
  RESTAURANT_CID, M, decodeOrders, decodeMyReservations, cancelReservation,
  type OrderRow, type ReservationRow,
} from '../lib/restaurant-api'
import { fmtE8s, relTime } from '../lib/config'
import { StatusPill, Spinner, EmptyState, ErrorNote, Button } from '../components/ui'

function windowLabel(r: ReservationRow): string {
  // chain→wall via the row's own nowNs
  const off = BigInt(Date.now()) * 1_000_000n - r.nowNs
  const fmt = (ns: bigint) =>
    new Date(Number((ns + off) / 1_000_000n)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${fmt(r.startNs)} → ${new Date(Number((r.endNs + off) / 1_000_000n)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export function MyOrders() {
  const { data, loading, error } = useQuery<OrderRow[]>(RESTAURANT_CID, M.myOrders, undefined, decodeOrders)
  const res = useQuery<ReservationRow[]>(RESTAURANT_CID, M.myReservations, undefined, decodeMyReservations)
  const [busy, setBusy] = useState<bigint>()
  const [err, setErr] = useState<string>()

  async function cancel(id: bigint) {
    setBusy(id)
    setErr(undefined)
    try { await cancelReservation(id); res.refetch() } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(undefined) }
  }

  if (loading) return <Spinner label="Loading your orders" />
  if (error) return <ErrorNote message={error} />
  const orders = data ?? []
  const bookings = res.data ?? []

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <section>
        <h1 className="font-display text-3xl font-semibold">Your orders</h1>
        {orders.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="No orders yet" hint="Build an order from the menu — you'll see it move from pending to delivered here." action={<Link to="/menu"><Button>See the menu</Button></Link>} />
          </div>
        ) : (
          <ul className="mt-5 space-y-3">
            {orders.map((o) => (
              <li key={o.id.toString()} className="card flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="font-display text-lg font-semibold">Order #{o.id.toString()}</p>
                  <p className="text-xs text-ink-soft nums">
                    {o.itemCount.toString()} items · ◈ {fmtE8s(o.totalAmount)} · {relTime(o.timestamp)}
                    {o.tableNumber > 0n && <> · table {o.tableNumber.toString()}</>}
                  </p>
                </div>
                <StatusPill status={o.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="font-display text-2xl font-semibold">Your bookings</h2>
        {err && <div className="mt-3"><ErrorNote message={err} /></div>}
        {bookings.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">
            No bookings — <Link className="text-[var(--color-chili)] hover:underline" to="/">pick a free table on the floor</Link> and book it.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {bookings.map((r) => (
              <li key={r.id.toString()} className="card flex items-center justify-between gap-4 p-4">
                <div>
                  <p className="font-display text-lg font-semibold">Table {r.tableNumber.toString()} <span className="text-sm font-normal text-ink-soft">party of {r.partySize.toString()}</span></p>
                  <p className="text-xs text-ink-soft nums">{windowLabel(r)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill status={r.status} />
                  {r.status === 'booked' && (
                    <Button variant="ghost" onClick={() => cancel(r.id)} disabled={busy === r.id}>
                      {busy === r.id ? 'Cancelling…' : 'Cancel'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
