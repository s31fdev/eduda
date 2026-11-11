import type { ReactNode } from 'react'
import { InputGroup, InputGroupAddon, InputGroupText } from '@repo/ui/components/input-group'

export function CurrencyInputGroup({
  children,
  disabled,
}: {
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <InputGroup data-disabled={disabled}>
      <InputGroupAddon aria-hidden="true">
        <InputGroupText>₽</InputGroupText>
      </InputGroupAddon>
      {children}
      <InputGroupAddon align="inline-end" aria-hidden="true">
        <InputGroupText>RUB</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  )
}
