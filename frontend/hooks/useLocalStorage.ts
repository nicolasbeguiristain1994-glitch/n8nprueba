'use client'

/**
 * useLocalStorage — hook para leer/escribir un valor en localStorage.
 *
 * Estrategia:
 *   - El lazy initializer de useState lee localStorage de forma SÍNCRONA en el
 *     cliente antes del primer render, devolviendo el valor correcto desde el
 *     inicio (sin necesidad de useEffect + skeleton).
 *   - En SSR (typeof window === 'undefined') devuelve `initialValue` de forma
 *     segura. El elemento que consuma este valor debe tener
 *     suppressHydrationWarning si es probable que server y client difieran.
 *   - Las escrituras son síncronas y directas — sin double-write.
 *
 * Re-renders: mínimos. El setter está memoizado con useCallback y solo cambia
 * si cambia `key`. El estado solo cambia cuando el valor efectivamente cambia.
 *
 * @example
 *   const [collapsed, setCollapsed] = useLocalStorage('sidebar:collapsed', false)
 *   const toggle = useCallback(() => setCollapsed(v => !v), [setCollapsed])
 */

import { useState, useCallback } from 'react'

type Updater<T> = T | ((prev: T) => T)

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: Updater<T>) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    // En SSR no hay localStorage — devolver el default para evitar errores
    if (typeof window === 'undefined') return initialValue
    try {
      const item = window.localStorage.getItem(key)
      return item !== null ? (JSON.parse(item) as T) : initialValue
    } catch {
      // localStorage bloqueado (modo privado extremo, CSP, etc.)
      return initialValue
    }
  })

  const setValue = useCallback(
    (value: Updater<T>) => {
      setStoredValue(prev => {
        const next =
          typeof value === 'function'
            ? (value as (prev: T) => T)(prev)
            : value
        try {
          window.localStorage.setItem(key, JSON.stringify(next))
        } catch {
          // Silenciar errores de escritura (cuota llena, etc.)
        }
        return next
      })
    },
    [key],
  )

  return [storedValue, setValue]
}
