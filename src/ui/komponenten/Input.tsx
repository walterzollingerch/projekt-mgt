import { cn } from '../../hilfen'
import { InputHTMLAttributes, forwardRef } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  helpText?: string
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, helpText, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, '-')
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            'w-full px-3 py-2 border rounded-md text-sm transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-[#1a5276] focus:border-transparent',
            'placeholder:text-gray-400',
            error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
            className
          )}
          {...props}
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        {helpText && !error && <p className="text-xs text-gray-500">{helpText}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
export default Input
