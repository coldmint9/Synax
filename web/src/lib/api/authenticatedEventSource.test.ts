import { afterEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./origin', () => ({ apiFetch: mock.fetch }))
import { AuthenticatedEventSource } from './authenticatedEventSource'
afterEach(() => { mock.fetch.mockReset(); vi.useRealTimers() })

describe('authenticated event transport', () => {
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
