import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./origin', () => ({ apiFetch: mock.fetch }))
import { AuthenticatedEventSource } from './authenticatedEventSource'
import { useApiConnectivityStore } from '../apiConnectivity'
beforeEach(() => {
  useApiConnectivityStore.setState({ browserOnline: true, apiReachable: 'reachable', recoveryVersion: 0 })
})
afterEach(() => { mock.fetch.mockReset(); vi.useRealTimers() })

describe('authenticated event transport', () => {
  it('replaces a stalled stream on wake, preserving its cursor and ignoring late data', async () => {
    vi.useFakeTimers()
    const streams: ReadableStreamDefaultController<Uint8Array>[] = []
    mock.fetch.mockImplementation(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { streams.push(controller) },
    }))))
    const source = new AuthenticatedEventSource('/api/events')
    const listener = vi.fn(), error = vi.fn()
    source.onmessage = listener
    source.onerror = error
    await vi.advanceTimersByTimeAsync(0)
    streams[0].enqueue(new TextEncoder().encode('id: 42\ndata: before sleep\n\n'))
    await vi.advanceTimersByTimeAsync(0)

    useApiConnectivityStore.getState().markSuccess(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.fetch).toHaveBeenCalledTimes(2)
    expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(true)
    expect(mock.fetch.mock.calls[1][1].headers).toMatchObject({ 'Last-Event-ID': '42' })
    streams[0].enqueue(new TextEncoder().encode('id: 43\ndata: stale\n\n'))
    streams[1].enqueue(new TextEncoder().encode('id: 44\ndata: recovered\n\n'))
    await vi.advanceTimersByTimeAsync(0)
    expect(listener.mock.calls.map(([event]) => event.data)).toEqual(['before sleep', 'recovered'])
    expect(error).not.toHaveBeenCalled()
    source.close()
    streams[1].close()
    useApiConnectivityStore.getState().markSuccess(true)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mock.fetch).toHaveBeenCalledTimes(2)
  })

  it('ignores a late failure from a connection replaced before its headers arrived', async () => {
    vi.useFakeTimers()
    let rejectOld!: (error: Error) => void
    let current!: ReadableStreamDefaultController<Uint8Array>
    mock.fetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(c) { current = c } })))
    const source = new AuthenticatedEventSource('/api/events')
    const error = vi.fn()
    source.onerror = error
    await vi.advanceTimersByTimeAsync(0)
    useApiConnectivityStore.getState().markSuccess(true)
    await vi.advanceTimersByTimeAsync(0)
    rejectOld(new Error('old connection failed'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mock.fetch).toHaveBeenCalledTimes(2)
    expect(source.readyState).toBe(AuthenticatedEventSource.OPEN)
    expect(error).not.toHaveBeenCalled()
    source.close()
    current.close()
  })

  it('parses chunked SSE and detaches without reporting a connection error', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    mock.fetch.mockResolvedValue(new Response(body))
    const source = new AuthenticatedEventSource('/api/events')
    const listener = vi.fn(), error = vi.fn(); source.addEventListener('snapshot', listener); source.onerror = error
    await vi.waitFor(() => expect(mock.fetch).toHaveBeenCalled())
    const encoder = new TextEncoder()
    controller.enqueue(encoder.encode('id: 42\r\nevent: snapshot\r\nda'))
    controller.enqueue(encoder.encode('ta: {"ok":true}\r\n\r\n'))
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
    expect(listener.mock.calls[0][0]).toMatchObject({ data: '{"ok":true}', lastEventId: '42' })
    source.close(); controller.close(); await Promise.resolve()
    expect(error).not.toHaveBeenCalled()
    expect((mock.fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
  })
  it('reconnects using the last observed cursor', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    mock.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode('id: 7\ndata: done\n\n')); c.close() } })))
    let second!: ReadableStreamDefaultController<Uint8Array>
    mock.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(c) { second = c } })))
    const source = new AuthenticatedEventSource('/api/events')
    await vi.advanceTimersByTimeAsync(1100)
    expect(mock.fetch).toHaveBeenCalledTimes(2)
    expect(mock.fetch.mock.calls[1][1].headers).toMatchObject({ 'Last-Event-ID': '7' })
    source.close(); second.close(); await vi.advanceTimersByTimeAsync(0)
  })
})
