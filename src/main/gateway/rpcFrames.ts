export function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

export function rpcError(id: unknown, code: number, message: string, data?: unknown): string {
  const error: { code: number; message: string; data?: unknown } = { code, message }
  if (data !== undefined) error.data = data
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error })
}
