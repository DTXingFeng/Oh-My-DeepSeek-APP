import { readFileSync } from 'node:fs'
import { connectWebView } from './webview-cdp.mjs'
const cdp = await connectWebView()
try {
  const expression = process.argv[2]
    ? readFileSync(process.argv[2], 'utf8')
    : `JSON.stringify({
    url: location.href, title: document.title, text: document.body.innerText.slice(0, 2500),
    scripts: [...document.scripts].map(s => s.src),
    native: !!window.OhMyDeepSeekAndroid, secure: window.isSecureContext,
    width: innerWidth, height: innerHeight
  })`
  console.log(await cdp.evaluate(expression))
  console.log(
    JSON.stringify(cdp.events.filter((event) => /exceptionThrown|entryAdded/.test(event.method)))
  )
} finally {
  cdp.close()
}
