/**
 * Service worker. Talks to SalesEngine; never to LinkedIn.
 *
 * Keeping all network access here means the content script — the only code that
 * runs on linkedin.com — has no network capability at all. It can read the page
 * it was injected into and fill a field, and that is the whole of its power.
 */

const DEFAULT_BASE = 'http://localhost:3000'

async function baseUrl() {
  const { baseUrl } = await chrome.storage.local.get('baseUrl')
  return (baseUrl || DEFAULT_BASE).replace(/\/$/, '')
}

async function fetchQueue() {
  const base = await baseUrl()
  const res = await fetch(`${base}/api/extension/queue`, {
    // The user's existing SalesEngine session is the auth. The extension holds
    // no token of its own, so there is nothing here to leak.
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (res.status === 401) return { ok: false, error: 'signed_out' }
  if (!res.ok) return { ok: false, error: `http_${res.status}` }
  return res.json()
}

async function postOutcome(payload) {
  const base = await baseUrl()
  const res = await fetch(`${base}/api/extension/queue`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) return { ok: false, error: `http_${res.status}` }
  return res.json()
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'GET_QUEUE') {
    fetchQueue().then(respond).catch((e) => respond({ ok: false, error: String(e) }))
    return true
  }
  if (msg?.type === 'RECORD_OUTCOME') {
    postOutcome(msg.payload).then(respond).catch((e) => respond({ ok: false, error: String(e) }))
    return true
  }
  if (msg?.type === 'SET_BASE') {
    chrome.storage.local.set({ baseUrl: msg.baseUrl }).then(() => respond({ ok: true }))
    return true
  }
  if (msg?.type === 'GET_BASE') {
    baseUrl().then((b) => respond({ ok: true, baseUrl: b }))
    return true
  }
  return false
})
