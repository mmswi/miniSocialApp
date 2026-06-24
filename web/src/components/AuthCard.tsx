import type { ReactNode } from 'react'

type Props = { title: string; children: ReactNode }

export const AuthCard = ({ title, children }: Props) => (
  <div className="flex min-h-screen items-center justify-center px-4">
    <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-4 text-xl font-semibold">{title}</h1>
      {children}
    </div>
  </div>
)
