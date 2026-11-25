import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchPapers } from '../../../app/src/Features/LocalAi/AlphaXivController.mjs'

test('performs MCP handshake and searches read-only with user query', async () => {
  const calls = []
  const mock = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body, headers: options.headers })
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: '[ID=1234.56789] paper' }] }
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  assert.match(await searchPapers('robot manipulation', 'fake-key', mock), /1234.56789/)
  assert.deepEqual(calls.map(x => x.body.method), ['initialize', 'notifications/initialized', 'tools/call'])
  assert.deepEqual(calls[2].body.params.arguments.keywords, ['robot manipulation'])
  assert.equal(calls[2].body.params.name, 'discover_papers')
})

test('rejects invalid queries before sending requests', async () => {
  let called = false
  await assert.rejects(searchPapers(' ', 'key', async () => { called = true }), /Invalid query/)
  await assert.rejects(searchPapers('paper', '', async () => { called = true }), /not configured/)
  assert.equal(called, false)
})
