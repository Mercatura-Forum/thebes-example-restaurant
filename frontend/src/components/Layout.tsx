import { NavLink, Outlet } from 'react-router-dom'
import { SignOutChip } from './MemphisGate'

const tabs = [
  { to: '/', label: 'Menu', end: true },
  { to: '/orders', label: 'My orders' },
  { to: '/kitchen', label: 'Kitchen' },
]

export function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-[var(--color-line)] bg-paper/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <NavLink to="/" className="font-display text-2xl font-semibold tracking-tight">
            Mesa<span className="text-[var(--color-chili)]">.</span>
          </NavLink>
          <nav className="flex items-center gap-1">
            {tabs.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end}
                className={({ isActive }) => `rounded-full px-3 py-1.5 text-sm font-semibold transition ${isActive ? 'bg-[var(--color-chili)]/10 text-[var(--color-chili-ink)]' : 'text-ink-soft hover:text-ink'}`}>
                {t.label}
              </NavLink>
            ))}
            <SignOutChip className="ml-2 border-l border-[var(--color-line)] pl-3" />
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8"><Outlet /></main>
      <footer className="mx-auto max-w-6xl px-5 py-8 text-xs text-ink-soft">
        An on-chain kitchen — the menu, dish photos, and every order live on the
        chain. Orders move forward only: pending → preparing → ready → delivered.
      </footer>
    </div>
  )
}
