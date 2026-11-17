import { execFileSync } from 'node:child_process'

export const SERIAL = process.env.ANDROID_SERIAL || '127.0.0.1:5555'
export const APP_ID = process.env.ANDROID_APP_ID || 'app.ohmydeepseek.android'
export const adb = (...args) =>
  execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim()

/** Connect only to our debuggable Android app, never to a personal browser. */
export const connectWebView = async () => {
  let pid
  for (let attempt = 0; attempt < 40 && !pid; attempt++) {
    try {
      const value = adb('shell', 'pidof', APP_ID).split(' ')[0]
      if (/^\d+$/.test(value)) pid = value
    } catch {
      /* Activity launch can return before the Android process becomes visible. */
    }
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!pid) throw new Error('Start the debug APK first')
  const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`)
  let target
  for (let attempt = 0; attempt < 40 && !target; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      target = targets.find((page) => page.url.startsWith('https://app.ohmydeepseek.local/'))
    } catch {
      /* Cold-started WebViews may close the first debugger connection. */
    }
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!target) {
    adb('forward', '--remove', `tcp:${port}`)
    throw new Error('App page not ready')
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  const events = []
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data)
    if (event.id) {
      const request = pending.get(event.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(event.id)
      if (event.error) request.reject(new Error(JSON.stringify(event.error)))
      else request.resolve(event.result)
    } else events.push(event)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 30_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Log.enable')
  return {
    send,
    evaluate,
    events,
    close: () => {
      socket.close()
      adb('forward', '--remove', `tcp:${port}`)
    },
  }
}
