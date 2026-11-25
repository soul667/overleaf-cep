import https from 'node:https'
// Server-side model access for authenticated project members. The API key never reaches the browser.
const instructions = {
  complete: 'Continue the LaTeX source naturally at the cursor. Return only the continuation; preserve LaTeX syntax and do not use code fences.',
  polish: 'Improve the academic writing of the selected LaTeX while preserving its meaning, citations, commands and formatting. Return only the revised LaTeX without code fences.',
  explain: 'Explain the supplied LaTeX compilation error clearly and suggest concrete fixes. Do not invent missing context.',
  chat: 'You are an academic writing assistant. Help with the user question and preserve the meaning of any LaTeX provided.',
}

export async function providerFetch(url, options) {
  const proxy = process.env.OVERLEAF_AI_HTTPS_PROXY
  if (!proxy) return fetch(url, options)
  const { HttpsProxyAgent } = await import('https-proxy-agent')
  const agent = new HttpsProxyAgent(proxy)
  try {
    return await new Promise((resolve, reject) => {
      const request = https.request(url, { method: options.method, headers: options.headers, agent, signal: options.signal }, response => {
        const chunks = []; let total = 0
        response.on('data', chunk => { total += chunk.length; if (total > 2_000_000) request.destroy(new Error('Response too large')); else chunks.push(chunk) })
        response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: { 'Content-Type': response.headers['content-type'] || 'application/json', ...(response.headers['mcp-session-id'] ? { 'Mcp-Session-Id': response.headers['mcp-session-id'] } : {}) } })))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(options.body)
    })
  } finally { agent.destroy() }
}

export async function generate({ mode, text, before = '', after = '' }, config = {}, fetcher = providerFetch) {
  if (!Object.hasOwn(instructions, mode) || typeof text !== 'string' || typeof before !== 'string' || typeof after !== 'string' || text.length + before.length + after.length > 30000) throw new Error('Invalid input')
  if (!config.key || !config.model) throw new Error('AI service is not configured')
  const input = mode === 'complete' ? `Before cursor:\n${before}\nAfter cursor:\n${after}` : text
  const response = await fetcher('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.model, instructions: instructions[mode], input, reasoning: { effort: config.reasoningEffort || 'medium' }, max_output_tokens: mode === 'complete' ? 256 : 1200, store: false }),
    signal: AbortSignal.timeout(45000),
  })
  if (!response.ok) throw new Error('AI provider request failed')
  const data = await response.json()
  const result = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('')
  if (!result) throw new Error('AI provider returned no text')
  return result
}

export async function generateResponse(req, res) {
  try {
    const text = await generate(req.body || {}, { key: process.env.OPENAI_API_KEY, model: process.env.OVERLEAF_AI_MODEL, reasoningEffort: process.env.OVERLEAF_AI_REASONING_EFFORT })
    res.set('Cache-Control', 'no-store').json({ text })
  } catch (error) {
    const message = error.message === 'Invalid input' || error.message === 'AI service is not configured' ? error.message : 'AI request failed'
    res.status(message === 'Invalid input' ? 400 : 503).json({ message })
  }
}
