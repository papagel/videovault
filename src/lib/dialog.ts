/**
 * Native dialog replacements for WKWebView (Tauri on macOS).
 * window.confirm() and window.prompt() are disabled in WKWebView,
 * so we show lightweight DOM overlays instead.
 */

export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const lines = message.split('\n').filter(Boolean)
    const el = document.createElement('div')
    el.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65)'

    el.innerHTML = `
      <div style="background:#16161f;border:1px solid #2a2a3a;border-radius:14px;padding:22px 24px;max-width:340px;box-shadow:0 24px 48px rgba(0,0,0,.6)">
        <p style="color:#e8e8f0;font-size:14px;font-weight:600;margin:0 0 8px">${lines[0]}</p>
        ${lines.slice(1).map((l) => `<p style="color:#8888aa;font-size:12px;margin:0 0 4px">${l}</p>`).join('')}
        <div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end">
          <button id="_dlg_cancel" style="padding:7px 16px;font-size:13px;color:#8888aa;background:#2a2a3a;border:none;border-radius:8px;cursor:pointer">Cancel</button>
          <button id="_dlg_ok" style="padding:7px 16px;font-size:13px;color:white;background:#ef4444;border:none;border-radius:8px;cursor:pointer">Confirm</button>
        </div>
      </div>`

    document.body.appendChild(el)
    const done = (val: boolean) => { document.body.removeChild(el); resolve(val) }
    el.querySelector('#_dlg_ok')!.addEventListener('click', () => done(true))
    el.querySelector('#_dlg_cancel')!.addEventListener('click', () => done(false))
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') done(true)
      if (e.key === 'Escape') done(false)
    })
    setTimeout(() => (el.querySelector('#_dlg_ok') as HTMLButtonElement)?.focus(), 20)
  })
}

export function showPrompt(title: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const el = document.createElement('div')
    el.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65)'

    el.innerHTML = `
      <div style="background:#16161f;border:1px solid #2a2a3a;border-radius:14px;padding:22px 24px;min-width:300px;box-shadow:0 24px 48px rgba(0,0,0,.6)">
        <p style="color:#e8e8f0;font-size:14px;font-weight:600;margin:0 0 12px">${title}</p>
        <input id="_pr_input" placeholder="${placeholder}" autocomplete="off"
          style="width:100%;background:#111118;border:1px solid #6366f1;color:#e8e8f0;font-size:13px;border-radius:8px;padding:8px 12px;outline:none;box-sizing:border-box" />
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <button id="_pr_cancel" style="padding:7px 16px;font-size:13px;color:#8888aa;background:#2a2a3a;border:none;border-radius:8px;cursor:pointer">Cancel</button>
          <button id="_pr_ok" style="padding:7px 16px;font-size:13px;color:white;background:#6366f1;border:none;border-radius:8px;cursor:pointer">OK</button>
        </div>
      </div>`

    document.body.appendChild(el)
    const input = el.querySelector('#_pr_input') as HTMLInputElement
    setTimeout(() => input?.focus(), 20)
    const done = (val: string | null) => { document.body.removeChild(el); resolve(val) }
    el.querySelector('#_pr_ok')!.addEventListener('click', () => done(input.value.trim() || null))
    el.querySelector('#_pr_cancel')!.addEventListener('click', () => done(null))
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') done(input.value.trim() || null)
      if (e.key === 'Escape') done(null)
    })
  })
}
