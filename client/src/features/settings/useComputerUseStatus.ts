import { useEffect, useState } from 'react'

export type ComputerUseStatus = { state: string; error: string | null }
export type ComputerUsePermissionTarget = 'accessibility' | 'screen-recording'
export type ComputerUsePermissions = {
  platform: string
  macOSMajorVersion: number | null
  accessibility: boolean | null
  screenRecording: boolean | null
  error: string | null
}

type ElectronComputerUseBridge = {
  getComputerUseStatus?: () => Promise<ComputerUseStatus>
  getComputerUsePermissions?: () => Promise<ComputerUsePermissions>
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

export async function openComputerUsePermission(target: ComputerUsePermissionTarget): Promise<void> {
  const api = (window as Window & { electronAPI?: { openComputerUsePermissions?: (value: ComputerUsePermissionTarget) => Promise<unknown> } }).electronAPI
  if (!api?.openComputerUsePermissions) throw new Error('System Settings are only available in the desktop app.')
  await api.openComputerUsePermissions(target)
}

export function useComputerUsePermissions(intervalMs = 5_000): {
  permissions: ComputerUsePermissions | null
  refresh: () => void
} {
  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null)
  const refresh = () => {
    const api = (window as Window & { electronAPI?: ElectronComputerUseBridge }).electronAPI
    void api?.getComputerUsePermissions?.().then(setPermissions).catch(() => {})
  }
  useEffect(() => {
    const api = (window as Window & { electronAPI?: ElectronComputerUseBridge }).electronAPI
    if (!api?.getComputerUsePermissions) return
    refresh()
    const timer = window.setInterval(refresh, intervalMs)
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])
  return { permissions, refresh }
}
