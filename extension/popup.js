const input = document.getElementById('base')
const status = document.getElementById('status')

chrome.runtime.sendMessage({ type: 'GET_BASE' }, (r) => {
  if (r?.ok) input.value = r.baseUrl
})

document.getElementById('save').onclick = () => {
  const baseUrl = input.value.trim()
  if (!/^https?:\/\//.test(baseUrl)) {
    status.textContent = 'Enter a full URL including http:// or https://'
    return
  }
  chrome.runtime.sendMessage({ type: 'SET_BASE', baseUrl }, (r) => {
    status.textContent = r?.ok ? 'Saved. Reload your LinkedIn tab.' : 'Could not save.'
  })
}
