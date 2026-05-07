import { useEffect, useRef } from 'react'

export interface Shortcut {
  key:    string
  ctrl?:  boolean
  shift?: boolean
  handler: () => void
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]): void {
  const ref = useRef(shortcuts)
  ref.current = shortcuts

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta    = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey
      const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      const hasCtrl = e.ctrlKey || e.metaKey

      for (const s of ref.current) {
        if (s.key !== e.key) continue
        if (s.ctrl  !== undefined && s.ctrl  !== meta)         continue
        if (s.shift !== undefined && s.shift !== e.shiftKey)   continue
        // Block bare-key shortcuts inside inputs, but allow ctrl combos and Escape
        if (inInput && !hasCtrl && s.key !== 'Escape') continue
        e.preventDefault()
        s.handler()
        break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
