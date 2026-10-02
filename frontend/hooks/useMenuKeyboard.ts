'use client'

import { useEffect, type RefObject } from 'react'

/** Keyboard navigation and focus restoration for the existing compact menus. */
export function useMenuKeyboard(open: boolean, root: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open || !root.current) return
    const element = root.current
    const trigger = element.querySelector<HTMLElement>('[aria-expanded]')
    const items = () => [...element.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')]
    items()[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      const options = items()
      const index = options.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        trigger?.focus()
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && options.length) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        options[next]?.focus()
      }
    }
    const handleFocus = (event: FocusEvent) => {
      if (!element.contains(event.relatedTarget as Node | null)) onClose()
    }
    element.addEventListener('keydown', handleKey)
    element.addEventListener('focusout', handleFocus)
    return () => {
      element.removeEventListener('keydown', handleKey)
      element.removeEventListener('focusout', handleFocus)
    }
  }, [open, root, onClose])
}
