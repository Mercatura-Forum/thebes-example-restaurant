import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@thebes/sdk'
import {
  RESTAURANT_CID, M, decodeFloor, decodeSeal, decodeAmKitchen,
  type FloorTable, type FloorSeal,
} from '../lib/restaurant-api'
import { FloorView } from '../components/Floor'
import { Button, Spinner, ErrorNote } from '../components/ui'

/** The dining room, live. The hero IS the floor: every table's true state
 *  drawn from chain, refreshed as it changes — the single-allocation law made
 *  visible. */
export function Home() {
  const floor = useQuery<FloorTable[]>(RESTAURANT_CID, M.floor, undefined, decodeFloor)
  const seal = useQuery<FloorSeal[]>(RESTAURANT_CID, M.seal, undefined, decodeSeal)
  const kitchen = useQuery<boolean>(RESTAURANT_CID, M.amKitchen, undefined, decodeAmKitchen)
  const s = seal.data?.[0]

  // The floor is LIVE — it breathes on its own, not only after your actions.
  useEffect(() => {
    const t = setInterval(() => { floor.refetch(); seal.refetch() }, 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floor.refetch, seal.refetch])

  return (
    <div>
      <header className="mx-auto max-w-3xl pb-2 pt-6 text-center">
        <p className="text-xs uppercase tracking-[0.24em] text-[var(--color-chili)]">Mesa · the dining room, live</p>
        <h1 className="font-display mt-3 text-5xl font-semibold leading-[1.0] md:text-6xl" style={{ textWrap: 'balance' }}>
          A table, honestly kept.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg leading-relaxed text-ink-soft">
          Every booking and every seating below is checked by the contract —
          one party per table, never two bookings for the same hour. Tap a free
          table to book it.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link to="/menu"><Button>See the menu</Button></Link>
          <Link to="/orders" className="text-sm font-medium text-[var(--color-chili)] hover:underline">My orders &amp; bookings →</Link>
        </div>
        {s && (
          <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-[var(--color-line)] bg-surface px-3.5 py-1.5 text-xs text-ink-soft">
            <span className={`h-1.5 w-1.5 rounded-full ${s.violations === 0n ? 'bg-[#4e8a3f]' : 'bg-[var(--color-chili)]'}`} aria-hidden />
            {s.tablesOnFloor.toString()} tables · {s.occupied.toString()} occupied · {s.reservedNow.toString()} reserved now ·{' '}
            {s.violations === 0n ? 'no double-allocations — audited on-chain' : `${s.violations.toString()} allocation violations!`}
          </p>
        )}
      </header>

      <section className="mx-auto mt-6 max-w-4xl">
        {floor.loading ? (
          <div className="flex justify-center py-16"><Spinner label="Setting the room" /></div>
        ) : floor.error ? (
          <ErrorNote message={floor.error} />
        ) : (
          <FloorView tables={floor.data ?? []} isKitchen={kitchen.data ?? false} onChanged={() => { floor.refetch(); seal.refetch() }} />
        )}
      </section>
    </div>
  )
}
