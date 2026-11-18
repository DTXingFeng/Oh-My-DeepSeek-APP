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
    await delay(75)
  }
  throw Error('Timeout: ' + expression)
}
const click = (text) =>
  cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`
  )
const input = (selector, value) =>
  cdp.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  )
const saved = () =>
  cdp.evaluate(
    `(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('ohmy-deepseek-memory');r.onsuccess=()=>resolve(r.result)});const rows=await new Promise(resolve=>{const r=db.transaction('saved').objectStore('saved').getAll();r.onsuccess=()=>resolve(r.result)});db.close();return rows})()`
  )
const openMemory = async () => {
  await cdp.evaluate(`document.querySelector('button[aria-label*="管理记忆"]').click()`)
  await wait(`!!document.querySelector('[data-memory-overview]')`)
}
const openSummary = async () => {
  await cdp.evaluate(`document.querySelector('button[aria-label="查看记忆摘要"]').click()`)
  await wait(`!!document.querySelector('[data-memory-overview]')`)
  await cdp.evaluate(`document.querySelector('[data-memory-overview] details').open=true`)
  await wait(`!!document.querySelector('textarea[aria-label="告诉我需要改什么"]')`)
}
const view = async (name) => {
  await cdp.evaluate(`document.querySelector('[data-memory-tab="${name}"]').click()`)
  await delay(50)
}
const entryAction = async (text, label) => {
  await cdp.evaluate(
    `[...document.querySelectorAll('[data-memory-overview] article')].find(e=>e.textContent.includes(${JSON.stringify(text)})).querySelector('button[aria-haspopup="menu"]').click()`
  )
  await wait(`!!document.querySelector('[role="menu"]')`)
  await click(label)
}
const screenshot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`evidence/local/overview-${name}.png`, Buffer.from(r.data, 'base64'))
}
const fixture = `(()=>{
window.__overviewCalls=[];window.__mainCalls=[];window.__mode='normal';
const original=window.fetch.bind(window);
window.fetch=async(url,init={})=>{
 if(!String(url).startsWith('https://api.deepseek.com'))return original(url,init);
 if(String(url).endsWith('/user/balance'))return new Response(JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'42.63',topped_up_balance:'40.00',granted_balance:'2.63'}]}));
 if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}));
 const body=JSON.parse(init.body);
 if(String(url).endsWith('/chat/completions')){
  const payload=JSON.parse(body.messages.at(-1).content);window.__overviewCalls.push({prompt:body.messages[0].content,payload});
  let result;
  if(body.messages[0].content.includes('记忆纠正助手')){
   const item=payload.memories.find(m=>/上海|北京/.test(m.text));result={changes:item?[{id:item.id,text:'用户现在居住在北京。'}]:[],forget:[]};
  }else result={entries:payload.memories.map(m=>({category:m.id==='location'?'background':m.id==='project'?'projects':'preferences',text:m.text,sourceIds:[m.id]}))};
  if(window.__mode==='bad')result={entries:[{category:'background',text:'虚构',sourceIds:['unknown']} ]};
  if(window.__mode==='held'){window.__waiting=true;await new Promise(resolve=>window.__release=resolve);window.__waiting=false;}
  else await new Promise(resolve=>setTimeout(resolve,150));
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
 }
 if(!String(url).endsWith('/messages'))throw Error('Unexpected paid request');
 window.__mainCalls.push(body);
 const events=[{type:'message_start',message:{id:'fixture',model:'deepseek-flash'}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'测试答复'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null,title:'摘要测试'}},{type:'message_stop'}];
 return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
};})()`
try {
  mkdirSync('evidence/local', { recursive: true })
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fixture })
  await wait('!!window.ohMyDeepSeekBack')
  await cdp.evaluate(`(async()=>{
    window.OhMyDeepSeekAndroid.writeApiKey('overview-fixture-key');localStorage.setItem('ohmy:memory-auto','false');localStorage.setItem('chat-demo:theme-preference','light');
    const db=await new Promise(resolve=>{const r=indexedDB.open('ohmy-deepseek-memory');r.onsuccess=()=>resolve(r.result)});
    const rows=[{id:'location',key:'profile.location',text:'用户居住在上海。',sourceSessionId:'old-home',sourceMessageId:'user-home'},{id:'style',key:'response.style',text:'用户偏好中文简短回答。'},{id:'project',key:'project.name',text:'用户持续开发蓝色风铃项目。'}];
    const tx=db.transaction('saved','readwrite');for(const row of rows)tx.objectStore('saved').put({...row,origin:'manual',createdAt:1,updatedAt:1});await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    const chats=await new Promise(resolve=>{const r=indexedDB.open('chat-demo');r.onsuccess=()=>resolve(r.result)});const chat={id:'old-home',title:'居住记录',createdAt:1,updatedAt:1,messages:[{id:'user-home',role:'user',content:'我目前住上海。',files:[],createdAt:1}]};const ct=chats.transaction(['sessions','sessionSummaries'],'readwrite');ct.objectStore('sessions').put(chat);ct.objectStore('sessionSummaries').put({id:chat.id,title:chat.title,createdAt:1,updatedAt:1,fileIds:[]});await new Promise(resolve=>ct.oncomplete=resolve);chats.close();
  })()`)
  await cdp.send('Page.reload')
  await wait('!!window.ohMyDeepSeekBack && !!window.__overviewCalls')
  await openMemory()
  await openSummary()
  assert.equal(await cdp.evaluate('window.__overviewCalls.length'), 0)
  assert.ok(
    await cdp.evaluate(
      `document.body.innerText.includes('关于你') && document.body.innerText.includes('工作、项目与计划')`
    )
  )
  check('local summary is grouped immediately without any model calls')
  await click('智能整理')
  await wait(`document.body.innerText.includes('摘要已整理')`)
  assert.equal((await saved()).filter((memory) => memory.overview).length, 3)
  check('model organization is validated and stored with original source mappings')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 892,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await delay(3100)
  await screenshot('mobile')
  await entryAction('中文简短', '编辑记忆')
  await wait(`!!document.querySelector('textarea[aria-label="记忆内容"]')`)
  await input('textarea[aria-label="记忆内容"]', '用户偏好中文简短回答，先给结论。')
  await click('保存记忆')
  await wait(`!document.querySelector('textarea[aria-label="记忆内容"]')`)
  assert.ok(
    await cdp.evaluate(
      `document.querySelector('[data-memory-overview]').textContent.includes('先给结论')`
    )
  )
  assert.equal(await cdp.evaluate('window.__overviewCalls.length'), 1)
  check('direct editing updates canonical memory and the summary without extra calls')
  await input('textarea[aria-label="告诉我需要改什么"]', '我现在住北京，不是上海。')
  await click('预览修改')
  await wait(`document.body.innerText.includes('核对修改内容')`)
  assert.ok((await saved()).some((memory) => memory.text.includes('上海')))
  check('written corrections show before/after proposals without writing them immediately')
  await click('保存这些修改')
  await wait(`!document.body.innerText.includes('核对修改内容')`)
  assert.equal(
    (await saved()).find((memory) => memory.id === 'location').text,
    '用户现在居住在北京。'
  )
  check('reviewed corrections update actual memory instead of only changing summary wording')
  await cdp.evaluate(
    `(()=>{const p=[...document.querySelector('[data-memory-overview]').querySelectorAll('article p')].find(p=>p.textContent.includes('北京'));const range=document.createRange();range.selectNodeContents(p);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);p.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`
  )
  await wait(`document.body.innerText.includes('纠正选中文字')`)
  await input('textarea[aria-label="告诉我需要改什么"]', '我住北京，保持这个信息。')
  await click('预览修改')
  await wait(`document.body.innerText.includes('核对修改内容')`)
  assert.deepEqual(
    await cdp.evaluate('window.__overviewCalls.at(-1).payload.memories.map(m=>m.id)'),
    ['location']
  )
  check('highlighted-text corrections only send the selected original memories')
  await click('取消')
  await entryAction('北京', '不再提起')
  await wait(`document.body.innerText.includes('不再提起的记忆（1）')`)
  assert.equal((await saved()).find((memory) => memory.id === 'location').muted, true)
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  const before = await cdp.evaluate('window.__mainCalls.length')
  await input('textarea', '我住哪里？')
  await cdp.evaluate(`document.querySelector('button[aria-label="发送"]').click()`)
  await wait(`window.__mainCalls.length===${before + 1}`)
  assert.equal(
    await cdp.evaluate(
      `window.__mainCalls.at(-1).system.includes('北京') || window.__mainCalls.at(-1).system.includes('上海')`
    ),
    false
  )
  check(
    'do-not-mention excludes both the saved fact and its known original history message from actual requests'
  )
  await wait(`!document.querySelector('button[aria-label^="停止"]')`)
  await openMemory()
  await openSummary()
  await cdp.evaluate(
    `[...document.querySelectorAll('details')].find(d=>d.textContent.includes('不再提起的记忆')).open=true`
  )
  await click('恢复引用')
  await wait(`!document.body.innerText.includes('不再提起的记忆（1）')`)
  assert.equal((await saved()).find((memory) => memory.id === 'location').muted, false)
  check('do-not-mention is reversible without deleting original facts or chats')

  await cdp.evaluate('window.__mode="bad"')
  const snapshot = JSON.stringify((await saved()).map(({ id, text }) => ({ id, text })))
  await click('智能整理')
  await wait(`document.body.innerText.includes('整理失败')`)
  assert.equal(JSON.stringify((await saved()).map(({ id, text }) => ({ id, text }))), snapshot)
  check('unknown source IDs or malformed model summaries leave original memories untouched')
  await cdp.evaluate('window.__mode="normal"')
  await input('textarea[aria-label="告诉我需要改什么"]', '我还是住在北京。')
  await click('预览修改')
  await wait(`document.body.innerText.includes('核对修改内容')`)
  await entryAction('北京', '编辑记忆')
  await wait(`!!document.querySelector('textarea[aria-label="记忆内容"]')`)
  await input('textarea[aria-label="记忆内容"]', '用户现在居住在深圳。')
  await click('保存记忆')
  await wait(`!document.querySelector('textarea[aria-label="记忆内容"]')`)
  await click('保存这些修改')
  await wait(`document.body.innerText.includes('记忆已经变化')`)
  assert.equal(
    (await saved()).find((memory) => memory.id === 'location').text,
    '用户现在居住在深圳。'
  )
  check('stale correction proposals cannot overwrite newer manual changes')
  await click('取消')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  })
  assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > innerWidth`), false)
  await cdp.evaluate(`document.body.setAttribute('data-ds-dark-theme','dark')`)
  await screenshot('dark-narrow')
  check('the summary is scrollable at 320 px and supports dark mode')
  await cdp.evaluate(`window.__mode='held'`)
  await click('智能整理')
  await wait('window.__waiting===true')
  await view('preferences')
  await click('清空保存的记忆')
  await click('删除')
  await wait(`document.querySelectorAll('[role="dialog"]').length===1`)
  await cdp.evaluate('window.__release()')
  await delay(200)
  assert.equal((await saved()).length, 0)
  check('clearing while a summary request is pending cannot resurrect deleted memory')
  await view('items')
  await click('添加记忆')
  await input('textarea[aria-label="记忆内容"]', '用户偏好蓝色主题。')
  await click('保存记忆')
  await wait(`!document.querySelector('textarea[aria-label="记忆内容"]')`)
  await view('preferences')
  await cdp.evaluate(
    `(()=>{const data=new DataTransfer();data.items.add(new File([JSON.stringify({format:'ohmy-deepseek-memory',version:2,saved:[{text:'用户不希望主动提起人工测试花园。',muted:true}],excluded:[]})],'summary-backup.json',{type:'application/json'}));const input=document.querySelector('input[accept=".json,application/json"]');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`
  )
  await wait(`document.body.innerText.includes('已添加 1 条记忆')`)
  assert.equal((await saved()).find((memory) => memory.text.includes('人工测试花园')).muted, true)
  check('version-2 memory backup import preserves do-not-mention preferences')
  await cdp.send('Page.reload')
  await wait('!!window.ohMyDeepSeekBack && !!window.__overviewCalls')
  await openMemory()
  await openSummary()
  assert.ok(await cdp.evaluate(`document.body.innerText.includes('不再提起的记忆（1）')`))
  assert.equal(await cdp.evaluate('window.__overviewCalls.length'), 0)
  check('reload restores the summary and muted state locally without a model call')
  await cdp.evaluate(`document.querySelector('details:last-child').open=true`)
  await click('删除并关闭记忆')
  await wait(`document.querySelectorAll('[role="dialog"]').length===2`)
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='删除并关闭记忆').at(-1).click()`
  )
  await wait(`document.querySelectorAll('[role="dialog"]').length===1`)
  assert.equal((await saved()).length, 0)
  await view('preferences')
  assert.equal(
    await cdp.evaluate(`document.querySelector('input[aria-label="使用保存的记忆"]').checked`),
    false
  )
  check(
    'delete-and-turn-off clears saved memory and disables personalization without deleting chats'
  )
  assert.equal(cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown').length, 0)
  check('summary workflows finish without uncaught JavaScript errors')
  writeFileSync(
    'evidence/local/overview-smoke.json',
    JSON.stringify(
      { responseSource: 'local fixtures, no paid requests or private history', passed },
      null,
      2
    )
  )
} finally {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  cdp.close()
}
