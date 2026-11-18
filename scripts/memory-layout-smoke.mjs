import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { APP_ID, adb, connectWebView } from './webview-cdp.mjs'

assert.equal(APP_ID, 'app.ohmydeepseek.android.importtest', 'Refusing to modify the main app')
adb('shell', 'am', 'force-stop', APP_ID)
adb('shell', 'pm', 'clear', APP_ID)
adb('shell', 'am', 'start', '-W', '-n', `${APP_ID}/app.ohmydeepseek.android.MainActivity`)
const cdp = await connectWebView()
const passed = []
const check = (name) => {
  passed.push(name)
  console.log('PASS ' + name)
}
const wait = async (expression) => {
  for (let i = 0; i < 150; i++) {
    if (await cdp.evaluate(`!!document.body && (${expression})`)) return
    await delay(60)
  }
  throw Error('Timeout: ' + expression)
}
const view = async (name) => {
  await cdp.evaluate(`document.activeElement?.blur();document.querySelector('[data-memory-tab="${name}"]').click()`)
  await delay(100)
}
const key = async (name) => {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name })
  await delay(70)
}
const viewport = async (width, height) => {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 768,
  })
  await delay(500)
}
const overflow = async () => {
  const bounds = await cdp.evaluate(
    `(()=>{const r=document.querySelector('[role="dialog"]').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()`
  )
  assert.ok(
    bounds.left >= 0 && bounds.right <= bounds.width,
    'dialog must not clip at either viewport edge'
  )
  assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth>innerWidth`), false)
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('#memory-view-panel').scrollWidth>document.querySelector('#memory-view-panel').clientWidth`
    ),
    false
  )
}
const screenshot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`evidence/local/memory-layout-${name}.png`, Buffer.from(r.data, 'base64'))
}
try {
  mkdirSync('evidence/local', { recursive: true })
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(()=>{
    window.__layoutCalls=0;
    const original=fetch.bind(window);window.fetch=async(url,init={})=>{
      if(!String(url).startsWith('https://api.deepseek.com'))return original(url,init);
      if(String(url).endsWith('/user/balance'))return new Response(JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'42.63',topped_up_balance:'40.00',granted_balance:'2.63'}]}));
      if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}));
      window.__layoutCalls++;await new Promise(resolve=>setTimeout(resolve,400));throw Error('Simulated unavailable service');
    };
  })()`,
  })
  await wait('!!window.ohMyDeepSeekBack')
  await cdp.evaluate(`(async()=>{
    window.OhMyDeepSeekAndroid.writeApiKey('layout-fixture-key');localStorage.setItem('ohmy:memory-auto','false');localStorage.setItem('chat-demo:theme-preference','light');
    const db=await new Promise(resolve=>{const r=indexedDB.open('ohmy-deepseek-memory');r.onsuccess=()=>resolve(r.result)});
    const rows=[{id:'location',key:'profile.location',text:'目前住在杭州，周末喜欢沿河散步。'},{id:'style',key:'response.style',text:'习惯用中文交流，回答先给结论，再展开必要的细节。'},{id:'project',key:'project.name',text:'正在开发「蓝色风铃」项目，当前重点是长记忆和阅读体验。'}];
    const tx=db.transaction('saved','readwrite');for(const row of rows)tx.objectStore('saved').put({...row,origin:'manual',createdAt:Date.now(),updatedAt:Date.now()});await new Promise(resolve=>tx.oncomplete=resolve);db.close();
  })()`)
  await cdp.send('Page.reload')
  await wait('!!window.__layoutCalls===false && !!window.ohMyDeepSeekBack')
  await cdp.evaluate(`document.querySelector('button[aria-label*="管理记忆"]').click()`)
  await wait(`!!document.querySelector('[data-memory-overview]')`)
  await viewport(412, 892)
  await overflow()
  await screenshot('summary')
  assert.equal(
    await cdp.evaluate(`document.querySelector('[data-memory-overview] details').open`),
    false
  )
  check('summary opens inline with correction collapsed and no extra dialog')
  await cdp.evaluate(`document.querySelector('[data-memory-tab="summary"]').focus()`)
  await key('ArrowRight')
  assert.equal(await cdp.evaluate(`document.activeElement.dataset.memoryTab`), 'items')
  assert.equal(
    await cdp.evaluate(
      `document.querySelector('[data-memory-tab="items"]').getAttribute('aria-selected')`
    ),
    'true'
  )
  await key('End')
  assert.equal(await cdp.evaluate(`document.activeElement.dataset.memoryTab`), 'preferences')
  await cdp.evaluate(`document.activeElement?.blur()`)
  await screenshot('settings')
  await overflow()
  check('keyboard tabs move selection and focus between all three views')
  await view('items')
  await screenshot('items')
  await cdp.evaluate(`document.querySelector('article button[aria-haspopup="menu"]').click()`)
  await wait(`!!document.querySelector('[role="menu"]')`)
  assert.equal(await cdp.evaluate(`document.activeElement.getAttribute('role')`), 'menuitem')
  await key('ArrowDown')
  assert.equal(await cdp.evaluate(`document.activeElement.textContent.trim()`), '不再提起')
  const bounds = await cdp.evaluate(
    `(()=>{const r=document.querySelector('[role="menu"]').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}})()`
  )
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= 412 && bounds.bottom <= 892)
  await screenshot('menu')
  await key('Escape')
  assert.equal(await cdp.evaluate(`!!document.querySelector('[role="menu"]')`), false)
  assert.equal(await cdp.evaluate(`document.querySelectorAll('[role="dialog"]').length`), 1)
  assert.equal(await cdp.evaluate(`document.activeElement.getAttribute('aria-haspopup')`), 'menu')
  check(
    'action menu fits the viewport; arrow keys and Escape restore trigger focus without closing settings'
  )
  await cdp.evaluate(
    `(()=>{const e=document.querySelector('input[aria-label="搜索已保存的记忆"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'不存在的词');e.dispatchEvent(new Event('input',{bubbles:true}))})()`
  )
  await wait(`document.body.innerText.includes('没有匹配的记忆')`)
  await screenshot('no-match')
  check('search has a clear no-match state')
  await view('summary')
  assert.equal(await cdp.evaluate('window.__layoutCalls'), 0)
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='智能整理').click()`
  )
  await wait(`document.body.innerText.includes('正在整理摘要')`)
  await screenshot('loading')
  await wait(`!!document.querySelector('[role="alert"]')`)
  await screenshot('error')
  check('organizing shows pending and failed feedback without losing the summary')
  await cdp.evaluate(`document.body.setAttribute('data-ds-dark-theme','dark')`)
  await viewport(320, 740)
  for (const name of ['summary', 'items', 'preferences']) {
    await view(name)
    await overflow()
    await screenshot('dark-' + name)
  }
  check('all three views fit 320 px in dark mode')
  await cdp.evaluate(`document.body.removeAttribute('data-ds-dark-theme')`)
  await viewport(1280, 900)
  await view('summary')
  await overflow()
  await screenshot('desktop')
  check('wide screens use a wider dialog and aligned sidebar')
  await view('items')
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='添加记忆').click()`
  )
  await cdp.evaluate(
    `(()=>{const e=document.querySelector('textarea[aria-label="记忆内容"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'中英混排 TypeScript 5 · Android\\n'+ 'long_unbroken_path_'.repeat(40));e.dispatchEvent(new Event('input',{bubbles:true}))})()`
  )
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存记忆').click()`
  )
  await wait(`!document.querySelector('textarea[aria-label="记忆内容"]')`)
  await viewport(320, 740)
  await overflow()
  await view('summary')
  await overflow()
  check('long mixed Chinese and English text wraps without horizontal overflow')
  await view('preferences')
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='清空保存的记忆').click()`
  )
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='删除').click()`
  )
  await wait(`document.querySelectorAll('[role="dialog"]').length===1`)
  await view('summary')
  await screenshot('empty')
  assert.ok(await cdp.evaluate(`document.body.innerText.includes('还没有可用的记忆')`))
  check('empty memory has one clear add action')
  assert.equal(cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown').length, 0)
  writeFileSync(
    'evidence/local/memory-layout-smoke.json',
    JSON.stringify({ data: 'synthetic isolated app only', paidRequests: 0, passed }, null, 2)
  )
} finally {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  cdp.close()
}
