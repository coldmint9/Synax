import { useEffect, useState } from 'react'

const FRAMES = ['(◕‿◕)ノ', '(⌐■_■)', '(づ◕‿◕)づ', '(•̀ᴗ•́)و']

export function GoalAsciiMood() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFrame(i => (i + 1) % FRAMES.length)
    }, 2400)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <span className="shrink-0 w-[4.5rem] font-mono text-[10px] text-primary tabular-nums">
      {FRAMES[frame]}
    </span>
  )
}
