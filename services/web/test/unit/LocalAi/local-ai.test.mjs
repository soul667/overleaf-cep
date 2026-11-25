import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generate } from '../../../app/src/Features/LocalAi/LocalAiController.mjs'

test('completion forwards context without storing responses', async () => {
  let request
  const text = await generate({ mode: 'complete', text: '', before: 'The result is ', after: '.' }, { key: 'test-key', model: 'test-model' }, async (url, options) => {
    request = { url, body: JSON.parse(options.body), headers: options.headers }
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'accurate' }] }] }) }
  })
  assert.equal(text, 'accurate')
  assert.equal(request.url, 'https://api.openai.com/v1/responses')
  assert.equal(request.body.store, false)
  assert.match(request.body.input, /The result is/)
  assert.equal(request.headers.Authorization, 'Bearer test-key')
})

test('rejects invalid and unconfigured requests before calling the provider', async () => {
  let calls = 0
  const fetcher = async () => { calls++; throw new Error('unexpected') }
  await assert.rejects(generate({ mode: 'bad', text: 'x' }, { key: 'k', model: 'm' }, fetcher), /Invalid input/)
  await assert.rejects(generate({ mode: 'chat', text: 'x' }, {}, fetcher), /not configured/)
  assert.equal(calls, 0)
})

test('does not expose upstream error details', async () => {
  await assert.rejects(generate({ mode: 'chat', text: 'x' }, { key: 'k', model: 'm' }, async () => ({ ok: false, status: 401 })), /AI provider request failed/)
})

test('refuses oversized prompts without calling the provider', async () => {
  let called = false
  await assert.rejects(generate({ mode: 'chat', text: 'a'.repeat(30001) }, { key: 'k', model: 'm' }, async () => { called = true }), /Invalid input/)
  assert.equal(called, false)
})

test('rejects malformed and empty provider output', async () => {
  await assert.rejects(generate({ mode: 'polish', text: 'sample' }, { key: 'k', model: 'm' }, async () => ({ ok: true, json: async () => ({ output: [] }) })), /no text/)
})
