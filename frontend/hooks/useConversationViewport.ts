'use client'

import { useEffect, useState } from 'react'

// Safari shrinks the visual viewport for its keyboard, but leaves 100dvh at
// the layout viewport height. Keep the inbox and composer inside the visible area.
export function useConversationViewport(enabled: boolean) {
  const [viewport, setViewport] = useState<{ height: number; top: number; keyboardOpen: boolean } | null>(null)

  useEffect(() => {
    const visual = window.visualViewport
    if (!enabled || !visual) return
    const mobile = window.matchMedia('(max-width: 767px)')
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (!mobile.matches || visual.scale !== 1) { setViewport(null); return }
        const keyboardOpen = window.innerHeight - visual.height > 120
        setViewport(keyboardOpen ? { height: visual.height, top: visual.offsetTop, keyboardOpen } : null)
      })
    }
    update()
    visual.addEventListener('resize', update)
    visual.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      visual.removeEventListener('resize', update)
      visual.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [enabled])

  return enabled ? viewport : null
}
