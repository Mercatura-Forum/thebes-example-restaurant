import { Link } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import { RESTAURANT_CID, M, decodeOrders, type OrderRow } from '../lib/restaurant-api'
import { fmtE8s, relTime } from '../lib/config'
import { StatusPill, Spinner, EmptyState, ErrorNote, Button } from '../components/ui'

export function MyOrders() {
  const { data, loading, error } = useQuery<OrderRow[]>(RESTAURANT_CID, M.myOrders, undefined, decodeOrders)
  if (loading) return <Spinner label="Loading your orders" />
  if (error) return <ErrorNote message={error} />
  const orders = data ?? []
  if (orders.length === 0) {
    return <EmptyState title="No orders yet" hint="Build an order from the menu — you'll see it move from pending to delivered here." action={<Link to="/"><Button>See the menu</Button></Link>} />
  }
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-semibold">Your orders</h1>
      <ul className="mt-5 space-y-3">
        {orders.map((o) => (
          <li key={o.id.toString()} className="card flex items-center justify-between gap-4 p-4">
            <div>
              <p className="font-display text-lg font-semibold">Order #{o.id.toString()}</p>
              <p className="text-xs text-ink-soft nums">{o.itemCount.toString()} items · ◈ {fmtE8s(o.totalAmount)} · {relTime(o.timestamp)}</p>
            </div>
            <StatusPill status={o.status} />
          </li>
        ))}
      </ul>
    </div>
  )
}
