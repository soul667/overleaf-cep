import { providerFetch } from './LocalAiController.mjs'
// A narrow, read-only AlphaXiv MCP client. The bearer token stays server-side.
const endpoint = 'https://api.alphaxiv.org/mcp/v1'
const protocol = '2025-03-26'

async function requestMcp(fetcher, key, payload, session) {
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol }
  if (session) headers['Mcp-Session-Id'] = session
  const response = await fetcher(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error('AlphaXiv request failed')
  if (response.status === 202 || response.status === 204) return { session: response.headers.get('mcp-session-id') || session }
  const body = await response.text()
  if (body.length > 1000000) throw new Error('AlphaXiv response too large')
  const type = response.headers.get('content-type') || ''
  const raw = type.includes('text/event-stream') ? body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n') : body
  const data = JSON.parse(raw)
  if (data.error || data.result?.isError) throw new Error('AlphaXiv request failed')
  return { data: data.result, session: response.headers.get('mcp-session-id') || session }
}

export async function searchPapers(query, key, fetcher = providerFetch) {
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Invalid query')
  if (!key) throw new Error('AlphaXiv is not configured')
  const initialized = await requestMcp(fetcher, key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'overleaf-ai', version: '0.1.0' } } })
  await requestMcp(fetcher, key, { jsonrpc: '2.0', method: 'notifications/initialized' }, initialized.session)
  const response = await requestMcp(fetcher, key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'discover_papers', arguments: { question: query.trim(), keywords: [query.trim()], difficulty: 1 } } }, initialized.session)
  return (response.data?.content || []).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n').slice(0, 50000)
}

export async function searchResponse(req, res) {
  try {
    const text = await searchPapers(req.body?.query, process.env.ALPHAXIV_API_KEY)
    res.set('Cache-Control', 'no-store').json({ text })
  } catch (error) {
    const message = ['Invalid query', 'AlphaXiv is not configured'].includes(error.message) ? error.message : 'AlphaXiv search failed'
    res.status(message === 'Invalid query' ? 400 : 503).json({ message })
  }
}
