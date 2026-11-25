// Inspired by AI Agent for Overleaf (MIT); this implementation integrates with
// Overleaf's own CodeMirror instance and server-side provider configuration.
import { EditorState, StateEffect, StateField, Prec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap } from '@codemirror/view'
import { completionStatus } from '@codemirror/autocomplete'
import { postJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'

const suggestion = StateEffect.define<string>()
class SuggestionWidget extends WidgetType {
  constructor(readonly text: string) { super() }
  toDOM() { const el = document.createElement('span'); el.textContent = this.text; el.className = 'ol-ai-suggestion'; el.style.opacity = '0.45'; el.style.whiteSpace = 'pre-wrap'; return el }
  ignoreEvent() { return true }
}
const field = StateField.define<string>({
  create: () => '',
  update(value, tr) { if (tr.docChanged || tr.selection) value = ''; for (const effect of tr.effects) if (effect.is(suggestion)) value = effect.value; return value },
})
// The widget must be placed at the cursor rather than at the start of the file.
const decorationField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = tr.docChanged || tr.selection ? Decoration.none : value.map(tr.changes)
    for (const effect of tr.effects) if (effect.is(suggestion)) value = effect.value ? Decoration.set([Decoration.widget({ widget: new SuggestionWidget(effect.value), side: 1 }).range(tr.state.selection.main.head)]) : Decoration.none
    return value
  },
  provide: f => EditorView.decorations.from(f),
})
const plugin = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController | undefined
  constructor(readonly view: EditorView) {}
  update(update: ViewUpdate) {
    if (!update.docChanged && !update.selectionSet) return
    clearTimeout(this.timer); this.controller?.abort()
    if (localStorage.getItem('local-ai-completion') !== 'true' || !update.view.hasFocus || !update.state.selection.main.empty || update.state.facet(EditorState.readOnly)) return
    const state = update.state, pos = state.selection.main.head
    const before = state.sliceDoc(Math.max(0, pos - 3500), pos), after = state.sliceDoc(pos, Math.min(state.doc.length, pos + 1000))
    if (!before.trim()) return
    this.timer = setTimeout(async () => {
      const controller = new AbortController(); this.controller = controller
      try {
        const result = await postJSON<{ text: string }>(`/project/${getMeta('ol-project_id')}/local-ai`, { body: { mode: 'complete', text: '', before, after }, signal: controller.signal })
        if (!controller.signal.aborted && this.view.state.doc.eq(state.doc) && this.view.state.selection.main.head === pos && this.view.state.selection.main.empty && this.view.hasFocus && localStorage.getItem('local-ai-completion') === 'true') this.view.dispatch({ effects: suggestion.of(result.text) })
      } catch { /* keep typing unaffected */ }
    }, 900)
  }
  destroy() { clearTimeout(this.timer); this.controller?.abort() }
})
export const inlineAiCompletion = [field, decorationField, plugin, Prec.high(keymap.of([
  { key: 'Tab', run: view => { const text = view.state.field(field); if (!text || localStorage.getItem('local-ai-completion') !== 'true' || completionStatus(view.state) || !view.state.selection.main.empty || view.state.facet(EditorState.readOnly)) return false; view.dispatch({ changes: { from: view.state.selection.main.head, insert: text }, effects: suggestion.of('') }); return true } },
  { key: 'Escape', run: view => { if (!view.state.field(field)) return false; view.dispatch({ effects: suggestion.of('') }); return true } },
]))]
