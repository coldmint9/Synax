import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  type: ToastType
  message: string
  action?: ToastAction
  duration?: number
  createdAt: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id' | 'createdAt'>) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (toast) => {
    const id = crypto.randomUUID().slice(0, 8)
    const entry: Toast = { ...toast, id, createdAt: Date.now() }
    set(s => ({ toasts: [...s.toasts, entry] }))
    const duration = toast.duration ?? 5000
    if (duration > 0) {
      setTimeout(() => {
        set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }))
      }, duration)
    }
    return id
  },

  dismiss: (id) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),

  clear: () => set({ toasts: [] }),
}))
