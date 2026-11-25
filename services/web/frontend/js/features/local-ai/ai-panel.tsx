import { useState } from 'react'
import { useEditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { useProjectContext } from '@/shared/context/project-context'
import { postJSON } from '@/infrastructure/fetch-json'

export default function AiPanel() {
  const { view } = useEditorViewContext()
  const { projectId } = useProjectContext()
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const [papers, setPapers] = useState('')
  const [history, setHistory] = useState<Array<{ question: string; answer: string }>>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<{ from: number; to: number; text: string; document: string } | null>(null)
  const [enabled, setEnabled] = useState(() => localStorage.getItem('local-ai-completion') === 'true')
  async function run(mode: 'chat' | 'polish' | 'explain') {
    const range = view?.state.selection.main
    const document = view?.state.doc.toString() || ''
    const selected = view && range ? view.state.sliceDoc(range.from, range.to) : ''
    if (mode !== 'polish' && !prompt.trim()) { setError('请输入内容'); return }
    if (mode === 'polish' && !selected) { setError('请先在编辑器中选中文字'); return }
    const text = mode === 'polish' ? selected : mode === 'chat' ? [...history.slice(-4).map(turn => `User: ${turn.question}\nAssistant: ${turn.answer}`), `User: ${prompt}`].join('\n\n') : prompt
    if (!text.trim()) { setError('请输入内容'); return }
    setError(''); setPending(true); setEdit(null)
    try {
      const result = await postJSON<{ text: string }>(`/project/${projectId}/local-ai`, { body: { mode, text } })
      setAnswer(result.text)
      if (mode === 'chat') { setHistory(previous => [...previous, { question: prompt, answer: result.text }]); setPrompt('') }
      if (mode === 'polish' && range) setEdit({ from: range.from, to: range.to, text: selected, document })
    } catch { setError('请求失败，请检查服务器模型配置或稍后重试') }
    finally { setPending(false) }
  }
  async function search() {
    if (!prompt.trim()) { setError('请输入文献搜索主题'); return }
    setError(''); setPending(true)
    try { const result = await postJSON<{ text: string }>(`/project/${projectId}/alphaxiv-search`, { body: { query: prompt } }); setPapers(result.text || '未找到结果') }
    catch { setError('AlphaXiv 搜索失败，请检查服务配置或网络') }
    finally { setPending(false) }
  }
  function apply() {
    if (!view || !edit || view.state.doc.toString() !== edit.document || view.state.sliceDoc(edit.from, edit.to) !== edit.text) { setError('选区已变化，请重新选择并生成'); return }
    const leading = edit.text.match(/^\s*/)?.[0] || ''
    const trailing = edit.text.match(/\s*$/)?.[0] || ''
    view.dispatch({ changes: { from: edit.from, to: edit.to, insert: leading + answer.trim() + trailing } })
    setEdit(null); view.focus()
  }
  return <div style={{ padding: 12, display: 'grid', gap: 8 }}>
    <h3>AI 写作助手</h3>
    <label><input type="checkbox" checked={enabled} onChange={event => { const value = event.target.checked; setEnabled(value); localStorage.setItem('local-ai-completion', String(value)) }} /> 行内 AI 续写</label>
    <p>选中文字后可润色；错误解释请粘贴编译错误。内容会发送给配置的模型服务。</p>
    <textarea aria-label="问题或编译错误" rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} />
    <div><button disabled={pending} onClick={() => run('chat')}>提问</button>{' '}<button disabled={pending} onClick={() => run('polish')}>润色选区</button>{' '}<button disabled={pending} onClick={() => run('explain')}>解释错误</button>{' '}<button disabled={pending} onClick={search}>搜索文献</button></div>
    {history.length > 0 && <div>{history.slice(0, -1).map((turn, index) => <div key={index}><strong>你：</strong><p>{turn.question}</p><strong>AI：</strong><p style={{ whiteSpace: 'pre-wrap' }}>{turn.answer}</p></div>)}<strong>你：</strong><p>{history[history.length - 1].question}</p></div>}
    {pending && <p>生成中…</p>}{error && <p role="alert">{error}</p>}
    {papers && <section><h4>AlphaXiv 文献搜索结果</h4><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{papers}</pre></section>}
    {answer && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{answer}</pre>}
    {edit && <button onClick={apply}>替换选区</button>}
  </div>
}
