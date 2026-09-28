import { useEffect, useState } from 'react'

export type ComputerUseStatus = { state: string; error: string | null }
export type ComputerUsePermissionTarget = 'accessibility' | 'screen-recording'

type ElectronComputerUseBridge = {
  getComputerUseStatus?: () => Promise<ComputerUseStatus>
}

/** Polls the Electron-hosted Cua driver status; returns null outside the desktop app. */
export function useComputerUseStatus(intervalMs = 5_000): ComputerUseStatus | null {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  useEffect(() => {
    let mounted = true
    const api = (window as Window & { electronAPI?: ElectronComputerUseBridge }).electronAPI
    if (!api?.getComputerUseStatus) return
    const refresh = () => {
      void api.getComputerUseStatus?.().then(state => { if (mounted) setStatus(state) }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, intervalMs)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [intervalMs])
  return status
}

export function openComputerUsePermission(target: ComputerUsePermissionTarget): void {
  const api = (window as Window & { electronAPI?: { openComputerUsePermissions?: (value: ComputerUsePermissionTarget) => Promise<unknown> } }).electronAPI
  void api?.openComputerUsePermissions?.(target)
}
