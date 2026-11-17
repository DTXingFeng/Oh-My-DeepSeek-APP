import { mkdirSync, writeFileSync } from 'node:fs'
import { connectWebView } from './webview-cdp.mjs'
const cdp=await connectWebView()
try {
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'})
  mkdirSync('docs/screenshots',{recursive:true})
  writeFileSync('docs/screenshots/android-home.png',Buffer.from(shot.data,'base64'))
  console.log(await cdp.evaluate('JSON.stringify({title:document.title,width:innerWidth,height:innerHeight,text:document.body.innerText})'))
} finally {cdp.close()}
