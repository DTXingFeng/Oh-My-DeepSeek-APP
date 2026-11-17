import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { connectWebView, adb, SERIAL } from './webview-cdp.mjs'

// Run only against an unused debug installation. All model responses are local fixtures.
const TEST_KEY = 'ohmydeepseek-local-test-key'
const results = {
  device: SERIAL,
  responseSource: 'local SSE fixtures, not real model inference',
  checks: [],
}
let cdp = await connectWebView()
const check = (name, details) => {
  results.checks.push({ name, passed: true, ...details })
  console.log(`PASS ${name}`)
}
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if (await cdp.evaluate(expression)) return
    } catch (error) {
      if (attempt === 79) throw error
    }
    await delay(100)
  }
  throw new Error(`Timed out: ${expression}`)
}
const reload = async () => {
  await cdp.send('Page.reload')
  await delay(300)
  await waitFor('!!document.querySelector("textarea") && !!window.ohMyDeepSeekBack')
}
const setInput = async (selector, value) => {
  await cdp.evaluate(`(() => {
    const field = document.querySelector(${JSON.stringify(selector)});
    if (!field) throw Error('Input missing');
    const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
}
const click = async (selector) =>
  cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)

const mockFetch = async () =>
  cdp.evaluate(`(() => {
  window.__requests = [];
  const original = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://api.deepseek.com')) return original(url, init);
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}), {status:200});
    if (!String(url).endsWith('/messages')) throw Error('Unexpected API request in test: ' + url);
    const body = JSON.parse(init.body);
    window.__requests.push({ url: String(url), body });
    const events = [
      {type:'message_start',message:{id:'fixture-'+window.__requests.length,model:'deepseek-flash'}},
      {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
      {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'这是本地模拟响应，用于验证客户端。'}},
      {type:'content_block_stop',index:0},
      {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:1,delta:{type:'text_delta',text:'模拟验收通过：中文流式回复、**Markdown** 和历史续聊正常。'}},
      {type:'content_block_stop',index:1},
      {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null,title:'客户端模拟验收'},usage:{input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:10}},
      {type:'message_stop'}
    ];
    const bytes = new TextEncoder().encode(events.map(event => 'event: '+event.type+'\\ndata: '+JSON.stringify(event)+'\\n\\n').join(''));
    let offset = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (init.signal?.aborted) { controller.error(new DOMException('Aborted','AbortError')); return; }
        if (offset === bytes.length) { controller.close(); return; }
        // Deliberately split UTF-8 characters and event boundaries.
        controller.enqueue(bytes.slice(offset, offset + 73));
        offset = Math.min(offset + 73, bytes.length);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }), {headers:{'Content-Type':'text/event-stream'}});
  };
})()`)

try {
  await waitFor('!!window.ohMyDeepSeekBack')
  const existing = await cdp.evaluate(`(async () => {
    const key=window.OhMyDeepSeekAndroid.readApiKey();
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('chat-demo');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
    const count=await new Promise(resolve=>{const req=db.transaction('sessions').objectStore('sessions').count();req.onsuccess=()=>resolve(req.result)});
    db.close();return {hasKey:key!=null && key!=='${TEST_KEY}', count};
  })()`)
  assert.equal(existing.hasKey, false, 'Refusing to modify a real credential')
  assert.equal(existing.count, 0, 'Use a fresh installation with no conversations')

  assert.equal(await cdp.evaluate(`window.OhMyDeepSeekAndroid.writeApiKey('${TEST_KEY}')`), true)
  assert.equal(
    await cdp.evaluate(`window.OhMyDeepSeekAndroid.readApiKey() === '${TEST_KEY}'`),
    true
  )
  cdp.close()
  adb('shell', 'am', 'force-stop', 'app.ohmydeepseek.android')
  adb('shell', 'am', 'start', '-n', 'app.ohmydeepseek.android/.MainActivity')
  await delay(1000)
  cdp = await connectWebView()
  assert.equal(
    await cdp.evaluate(`window.OhMyDeepSeekAndroid.readApiKey() === '${TEST_KEY}'`),
    true
  )
  assert.equal(await cdp.evaluate(`localStorage.getItem('chat-demo:api-key')`), null)
  check('Keystore credential survives process restart and is absent from localStorage')

  await cdp.evaluate('window.OhMyDeepSeekAndroid.writeApiKey(null)')
  await reload()
  await mockFetch()
  await setInput('input[type=password]', TEST_KEY)
  await waitFor(
    `[...document.querySelectorAll('button')].some(button=>button.textContent==='确定' && !button.disabled)`
  )
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent==='确定').click()`
  )
  await waitFor(`window.OhMyDeepSeekAndroid.readApiKey() === '${TEST_KEY}'`)
  check('Settings verifies and saves API key through native encrypted storage')
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await waitFor('!document.querySelector("[role=dialog]")')
  check('Android back closes the settings dialog')

  await cdp.evaluate(
    `document.querySelector('button[aria-label="深度思考"][aria-pressed="false"]')?.click()`
  )
  await cdp.evaluate(
    `document.querySelector('button[aria-label="智能搜索"][aria-pressed="false"]')?.click()`
  )
  const longInput = '长'.repeat(50_001)
  await setInput('textarea', longInput)
  await click('button[aria-label="发送"]')
  await waitFor(
    `document.body.innerText.includes('模拟验收通过') && !document.querySelector('button[aria-label="停止生成"]')`
  )
  const first = await cdp.evaluate(`(() => {
    const request=window.__requests[0];
    const input=request.body.messages.findLast(message=>message.role==='user');
    return {url:request.url,length:typeof input.content==='string'?input.content.length:input.content.filter(b=>b.type==='text').map(b=>b.text).join('').length,
      thinking:request.body.thinking.type,tools:request.body.tools.map(t=>t.type),bold:[...document.querySelectorAll('strong')].some(e=>e.textContent==='Markdown')};
  })()`)
  assert.equal(first.length, longInput.length)
  assert.equal(first.thinking, 'enabled')
  assert.ok(first.tools.includes('deepseek_web_search'))
  assert.ok(first.tools.includes('deepseek_read_url'))
  assert.equal(first.bold, true)
  check(
    '50,001-character input, thinking/search parameters, fragmented UTF-8 SSE and Markdown',
    first
  )

  await delay(500)
  await cdp.evaluate(`(async () => {
    const db=await new Promise(resolve=>{const r=indexedDB.open('chat-demo');r.onsuccess=()=>resolve(r.result)});
    const tx=db.transaction(['sessions','sessionSummaries'],'readwrite');
    const old=Date.now()-30*24*60*60*1000;
    for(const name of ['sessions','sessionSummaries']){
      const store=tx.objectStore(name);const req=store.openCursor();
      req.onsuccess=()=>{const cursor=req.result;if(cursor){cursor.update({...cursor.value,createdAt:old,updatedAt:old,title:'[TEST] 30天前对话'});cursor.continue()}};
    }
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=reject});db.close();
  })()`)
  await reload()
  await mockFetch()
  await click('button[aria-label="打开边栏"]')
  await waitFor(`document.body.innerText.includes('[TEST] 30天前对话')`)
  await cdp.evaluate(
    `[...document.querySelectorAll('div')].reverse().find(e=>e.textContent==='[TEST] 30天前对话')?.click()`
  )
  await waitFor(`document.body.innerText.includes('模拟验收通过')`)
  await setInput('textarea', '继续这个三十天前的对话（模拟测试）')
  await click('button[aria-label="发送"]')
  await waitFor('window.__requests.length === 1')
  await waitFor(`document.querySelectorAll('strong').length >= 2`)
  const history = await cdp.evaluate(`window.__requests[0].body.messages.map(m=>m.role)`)
  assert.ok(history.filter((role) => role === 'user').length >= 2)
  assert.ok(history.includes('assistant'))
  check('A conversation idle for 30 days resumes with the previous context', { roles: history })

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('evidence/local', { recursive: true })
  writeFileSync('evidence/local/android-smoke.png', Buffer.from(screenshot.data, 'base64'))
  results.runtimeErrors = cdp.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params.exceptionDetails.text)
  assert.deepEqual(results.runtimeErrors, [])
  check('No uncaught runtime exceptions during the simulated chat flow')
} finally {
  try {
    // Only this script's known test data can exist: checked before any mutation.
    if (results.checks.length > 0) {
      await cdp.evaluate(`(async () => {
        window.OhMyDeepSeekAndroid.writeApiKey(null);
        const db=await new Promise(resolve=>{const r=indexedDB.open('chat-demo');r.onsuccess=()=>resolve(r.result)});
        const names=[...db.objectStoreNames];const tx=db.transaction(names,'readwrite');
        names.forEach(name=>tx.objectStore(name).clear());
        await new Promise(resolve=>{tx.oncomplete=resolve});db.close();
      })()`)
      await reload()
    }
  } finally {
    cdp.close()
    mkdirSync('evidence/local', { recursive: true })
    writeFileSync('evidence/local/android-smoke.json', JSON.stringify(results, null, 2))
  }
}
