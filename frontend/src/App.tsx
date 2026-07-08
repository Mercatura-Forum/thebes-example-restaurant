import { Routes, Route } from 'react-router-dom'
import { MemphisGate } from './components/MemphisGate'
import { Layout } from './components/Layout'
import { Home } from './pages/Home'
import { Menu } from './pages/Menu'
import { MyOrders } from './pages/MyOrders'
import { Kitchen } from './pages/Kitchen'

export function App() {
  return (
    <MemphisGate appName="Mesa" tagline="Sign in to order.">
      <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/menu" element={<Menu />} />
        <Route path="/orders" element={<MyOrders />} />
        <Route path="/kitchen" element={<Kitchen />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
    </MemphisGate>
  )
}
