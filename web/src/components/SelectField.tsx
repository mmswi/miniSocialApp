import type { ComponentProps } from 'react'

type Props = ComponentProps<'select'> & { label: string }

// The <select> twin of TextField — same label + control shape, so a form can mix the two with no visual
// drift. The caller passes the <option>s as children; this owns only the label and the field styling.
export const SelectField = ({ label, children, ...selectProps }: Props) => (
  <label className="block">
    <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
    <select
      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
      {...selectProps}
    >
      {children}
    </select>
  </label>
)
