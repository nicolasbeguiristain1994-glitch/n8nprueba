'use client'

/**
 * ThemeProvider — wrapper delgado sobre next-themes.
 * Marcado como 'use client' para que el root layout (Server Component)
 * pueda importarlo sin necesitar ser también cliente.
 */

import { ThemeProvider as NextThemesProvider } from 'next-themes'
import type { ComponentProps } from 'react'

type Props = ComponentProps<typeof NextThemesProvider>

export function ThemeProvider({ children, ...props }: Props) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
