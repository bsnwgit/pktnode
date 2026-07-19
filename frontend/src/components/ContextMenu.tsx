import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('contextmenu', handlePointer)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('contextmenu', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  // Keep the menu on-screen if it was opened near the right/bottom edge.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 36 - 16),
  }

  return (
    <div
      ref={ref}
      style={style}
      className="fixed z-50 min-w-[180px] bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1"
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => { onClose(); item.onClick() }}
          className={`w-full text-left px-3 py-2 text-sm transition-colors ${
            item.danger ? 'text-red-400 hover:bg-red-900/30' : 'text-white hover:bg-gray-800'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
