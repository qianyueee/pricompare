/** 写文本进剪贴板；无 Clipboard API 权限时退回 execCommand */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 表格进剪贴板：纯文本（TSV）+ HTML 表格。Excel、WPS 粘贴时用 HTML（底色、字体、边框、金额格式都在），
 * 只认纯文本的地方照旧拿到 TSV。
 *
 * 先在 copy 事件里写：HTML 原样进剪贴板，桌面版和各浏览器都支持；写不进去再用 Clipboard API，再不行只写纯文本。
 * 要在点击/按键的处理里直接调用（浏览器只在用户操作时允许写剪贴板）。
 */
export async function copyTable(payload: { text: string; html: string }): Promise<boolean> {
  if (copyViaEvent(payload)) return true
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
          'text/html': new Blob([payload.html], { type: 'text/html' }),
        }),
      ])
      return true
    }
  } catch {
    // 退回只写纯文本
  }
  return copyText(payload.text)
}

function copyViaEvent(payload: { text: string; html: string }): boolean {
  let wrote = false
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return
    e.clipboardData.setData('text/plain', payload.text)
    e.clipboardData.setData('text/html', payload.html)
    e.preventDefault()
    wrote = true
  }
  document.addEventListener('copy', onCopy, true)
  try {
    return document.execCommand('copy') && wrote
  } catch {
    return false
  } finally {
    document.removeEventListener('copy', onCopy, true)
  }
}
