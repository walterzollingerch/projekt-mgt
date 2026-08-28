'use client'
import { cn } from '../../hilfen'
import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  footer?: React.ReactNode
}

export default function Modal({ open, onClose, title, children, size = 'md', footer }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) {
      document.addEventListener('keydown', handleKey)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      {/* Mobile: Bottom-Sheet, Desktop: zentriertes Modal */}
      <div className={cn('bg-white rounded-t-2xl sm:rounded-xl shadow-2xl w-full flex flex-col max-h-[92vh] sm:max-h-[90vh]', sizeClasses[size])}>
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100">
          <h3 className="text-base sm:text-lg font-semibold text-gray-800">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors rounded-md p-1 hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-4 sm:px-6 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && (
          <div className="px-4 sm:px-6 py-4 border-t border-gray-100 flex flex-wrap justify-end gap-2 sm:gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
