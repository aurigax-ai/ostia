import { statusMatches } from './browseInput'

export interface NetworkRequest {
  requestId: string
  url: string
  method: string
  type: string
  status?: number
  mimeType?: string
  error?: string
  finished: boolean
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  ts: number
}

export interface NetworkFilter {
  filter?: string
  types?: string[]
  method?: string
  status?: string
}

export function filterRequests(
  requests: NetworkRequest[],
  filter: NetworkFilter,
): NetworkRequest[] {
  const types = filter.types?.map((t) => t.toLowerCase()).filter(Boolean)
  return requests.filter((req) => {
    if (filter.filter && !req.url.includes(filter.filter)) return false
    if (types && types.length > 0 && !types.includes(req.type.toLowerCase())) return false
    if (filter.method && req.method.toUpperCase() !== filter.method.toUpperCase()) return false
    if (filter.status && !statusMatches(filter.status, req.status)) return false
    return true
  })
}

export function summarizeRequest(
  req: NetworkRequest,
): Omit<NetworkRequest, 'requestHeaders' | 'responseHeaders'> {
  const { requestHeaders: _req, responseHeaders: _res, ...summary } = req
  return summary
}
