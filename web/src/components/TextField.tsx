import type { ComponentProps } from 'react'

type Props = ComponentProps<'input'> & { label: string }

export const TextField = ({ label, ...inputProps }: Props) => (
  <label className="block">
    <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
    <input
      className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
      {...inputProps}
    />
  </label>
)
