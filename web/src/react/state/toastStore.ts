import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'error' | 'warning'

export interface ToastAction {
  label: string
  onClick: () => void
  variant?: 'default' | 'primary' | 'danger'
}

export interface Toast {
  id: string
  type: ToastType
  message: string
  action?: ToastAction
  actions?: ToastAction[]
  duration?: number
  createdAt: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'createdAt'> & { id?: string }) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (toast) => {
    const id = toast.id ?? crypto.randomUUID().slice(0, 8)
    const existing = useToastStore.getState().toasts.find(t => t.id === id)
    if (existing) return id
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
