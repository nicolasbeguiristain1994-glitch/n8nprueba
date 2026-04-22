import { redirect } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { getSessionFromCookies } from '@/lib/auth'

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionFromCookies()
  if (!session) {
    redirect('/login')
  }

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6">
        {children}
      </main>
    </div>
  )
}
