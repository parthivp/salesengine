/**
 * Content script — the only code that runs on linkedin.com.
 *
 * It has no network access (all fetching lives in the service worker), and it
 * does exactly two things to the page:
 *
 *   1. injects a panel showing the current queue card
 *   2. when the rep clicks "Fill note", writes the draft into LinkedIn's own
 *      note textarea
 *
 * It never clicks Send, never submits a form, never reads anything outside the
 * connect dialog, and never runs on a timer. Every action starts with a click by
 * the person sitting there.
 */

const PANEL_ID = 'salesengine-queue-panel'

let cards = []
let index = 0
let collapsed = false

function send(type, payload) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type, payload }, resolve))
}

// --- filling the note ------------------------------------------------------

/**
 * LinkedIn's connect dialog has no stable id, so find the textarea by the
 * attributes that have held up: an explicit name, or a dialog-scoped textarea.
 * If none is present, say so rather than writing into a random field.
 */
function findNoteField() {
  const selectors = [
    'textarea[name="message"]',
    '#custom-message',
    'div[role="dialog"] textarea',
    'textarea[id*="custom-message"]',
  ]
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (el && el.offsetParent !== null) return el
  }
  return null
}

function fillNote(text) {
  const field = findNoteField()
  if (!field) {
    return {
      ok: false,
      error:
        'No note field open. Click Connect on the profile first, then "Add a note", then try again.',
    }
  }

  // React controls this field, so setting .value alone is discarded on the next
  // render. Write through the native setter and dispatch the events React listens
  // for — this is the standard approach for a controlled input.
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set
  if (setter) setter.call(field, text)
  else field.value = text

  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
  field.focus()

  return { ok: true }
}

// --- panel -----------------------------------------------------------------

function render() {
  let panel = document.getElementById(PANEL_ID)
  if (!panel) {
    panel = document.createElement('div')
    panel.id = PANEL_ID
    document.body.appendChild(panel)
  }

  if (collapsed) {
    panel.className = 'se-panel se-collapsed'
    panel.innerHTML = `<button class="se-reopen" title="Open the SalesEngine queue">SE ${cards.length}</button>`
    panel.querySelector('.se-reopen').onclick = () => { collapsed = false; render() }
    return
  }

  panel.className = 'se-panel'

  if (!cards.length) {
    panel.innerHTML = `
      <div class="se-head">
        <span class="se-title">SalesEngine</span>
        <button class="se-x" title="Collapse">–</button>
      </div>
      <div class="se-body">
        <p class="se-muted">Queue is empty, or you are signed out of SalesEngine.</p>
        <button class="se-btn se-secondary" id="se-refresh">Refresh</button>
      </div>`
    panel.querySelector('.se-x').onclick = () => { collapsed = true; render() }
    panel.querySelector('#se-refresh').onclick = load
    return
  }

  const card = cards[index]
  const over = card.text.length > card.limit

  panel.innerHTML = `
    <div class="se-head">
      <span class="se-title">SalesEngine</span>
      <span class="se-count">${index + 1} / ${cards.length}</span>
      <button class="se-x" title="Collapse">–</button>
    </div>
    <div class="se-body">
      <p class="se-name">${escapeHtml(card.name)}</p>
      <p class="se-muted">${escapeHtml([card.title, card.company].filter(Boolean).join(' · '))}</p>
      ${card.generic ? '<p class="se-warn">Generic draft — thin record</p>' : ''}
      <textarea id="se-draft" rows="5">${escapeHtml(card.text)}</textarea>
      <p class="${over ? 'se-warn' : 'se-muted'}" id="se-count">${card.text.length} / ${card.limit}</p>
      <button class="se-btn" id="se-fill">Fill note</button>
      <p class="se-muted se-note">Fills the field. You press LinkedIn's Send.</p>
      <div class="se-row">
        <button class="se-btn se-ok" id="se-sent">I sent it</button>
        <button class="se-btn se-secondary" id="se-skip">Skip</button>
      </div>
      <div class="se-row">
        <a class="se-link" href="${escapeAttr(card.profileUrl || '#')}" target="_blank" rel="noopener">Open profile</a>
        <button class="se-linkbtn" id="se-next">Next card</button>
      </div>
      <p class="se-status" id="se-status"></p>
    </div>`

  const draft = panel.querySelector('#se-draft')
  const counter = panel.querySelector('#se-count')
  const status = panel.querySelector('#se-status')

  draft.oninput = () => {
    cards[index].text = draft.value
    counter.textContent = `${draft.value.length} / ${card.limit}`
    counter.className = draft.value.length > card.limit ? 'se-warn' : 'se-muted'
  }

  panel.querySelector('.se-x').onclick = () => { collapsed = true; render() }

  panel.querySelector('#se-fill').onclick = () => {
    const r = fillNote(draft.value)
    status.textContent = r.ok ? 'Filled. Review it, then press Send.' : r.error
    status.className = r.ok ? 'se-status se-good' : 'se-status se-warn'
  }

  panel.querySelector('#se-sent').onclick = async () => {
    status.textContent = 'Recording…'
    const r = await send('RECORD_OUTCOME', {
      taskId: card.taskId, outcome: 'sent', finalText: draft.value,
    })
    if (r?.ok) {
      cards.splice(index, 1)
      if (index >= cards.length) index = Math.max(0, cards.length - 1)
      render()
    } else {
      status.textContent = r?.error === 'signed_out' ? 'Signed out of SalesEngine.' : 'Could not record that.'
      status.className = 'se-status se-warn'
    }
  }

  panel.querySelector('#se-skip').onclick = async () => {
    await send('RECORD_OUTCOME', { taskId: card.taskId, outcome: 'skipped' })
    cards.splice(index, 1)
    if (index >= cards.length) index = Math.max(0, cards.length - 1)
    render()
  }

  panel.querySelector('#se-next').onclick = () => {
    index = (index + 1) % cards.length
    render()
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;')
}

async function load() {
  const r = await send('GET_QUEUE')
  cards = r?.ok && Array.isArray(r.cards) ? r.cards : []
  index = 0
  render()
}

// Injected once on page load. No polling, no MutationObserver watching LinkedIn's
// DOM — the rep opens the panel and refreshes it when they want to.
load()
