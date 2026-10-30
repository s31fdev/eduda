'use client'

import { Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'

import { Button } from '@repo/ui/components/button'
import { type ComponentProps, useSyncExternalStore } from 'react'

export function SwitchThemeButton({
  variant = 'outline',
  className,
}: Pick<ComponentProps<typeof Button>, 'variant' | 'className'>) {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  )

  return (
    <Button
      variant={variant}
      size="icon-lg"
      className={className}
      aria-label="Сменить тему"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {mounted && (resolvedTheme === 'dark' ? <Moon /> : <Sun />)}
    </Button>
  )
}
