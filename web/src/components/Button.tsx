import type { ComponentProps } from 'react'

type Props = ComponentProps<'button'> & { variant?: 'primary' | 'secondary' }

const variantClass: Record<'primary' | 'secondary', string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
}

export const Button = ({ variant = 'primary', className, ...buttonProps }: Props) => (
  <button
    className={`w-full rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${variantClass[variant]} ${className ?? ''}`}
    {...buttonProps}
  />
)
