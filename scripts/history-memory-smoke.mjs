import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { strToU8, zipSync } from 'fflate'
import { APP_ID, adb, connectWebView } from './webview-cdp.mjs'

assert.equal(APP_ID, 'app.ohmydeepseek.android.importtest', 'Only use an isolated installation')
adb('shell', 'am', 'force-stop', APP_ID)
adb('shell', 'pm', 'clear', APP_ID)
adb('shell', 'am', 'start', '-W', '-n', `${APP_ID}/app.ohmydeepseek.android.MainActivity`)
const cdp = await connectWebView()
const wait = async (expression) => {
  for (let i = 0; i < 150; i++) {
    if (await cdp.evaluate(`!!document.body && (${expression})`)) return
    await delay(75)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}
const click = async (label) => {
  const button = `[...document.querySelectorAll('button')].reverse().find(b=>!b.disabled&&b.textContent.trim()===${JSON.stringify(label)})`
  await wait(`!!(${button})`)
  await cdp.evaluate(`${button}.click()`)
}
const phase = (name) => wait(`!!document.querySelector('[data-history-memory-phase="${name}"]')`)
const saved = () =>
  cdp.evaluate(`(async()=>{
  const db=await new Promise(resolve=>{const r=indexedDB.open('ohmy-deepseek-memory');r.onsuccess=()=>resolve(r.result)});
  const rows=await new Promise(resolve=>{const r=db.transaction('saved').objectStore('saved').getAll();r.onsuccess=()=>resolve(r.result)});db.close();return rows;
})()`)
const mockedApi = `(()=>{
  const original=fetch.bind(window);
  window.__historyCalls=[];window.__chatCalls=[];window.__hold=true;
  window.fetch=async(url,init={})=>{
    if(!String(url).startsWith('https://api.deepseek.com'))return original(url,init);
    if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}));
    if(String(url).endsWith('/user/balance'))return new Response(JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'10',topped_up_balance:'10',granted_balance:'0'}]}));
    const body=JSON.parse(init.body);
    if(String(url).endsWith('/chat/completions')){
      const payload=JSON.parse(body.messages.at(-1).content);window.__historyCalls.push({body,payload});
      if(payload.user.includes('蓝色风铃')&&window.__hold){window.__held=true;await new Promise(resolve=>window.__release=resolve);window.__held=false;}
      const preferences=payload.user.includes('绿茶')?[{text:'用户喜欢绿茶。',key:'preferences.tea'}]:payload.user.includes('杭州')?[{text:'用户居住在杭州。',key:'profile.city'}]:[{text:'用户在开发蓝色风铃项目。',key:'project.name'}];
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({memories:preferences,forget:['current-tea']})}}]}));
    }
    if(!String(url).endsWith('/messages'))throw Error('Unexpected API request');
    window.__chatCalls.push(body);
    const events=[{type:'message_start',message:{id:'fixture',model:'deepseek-flash'}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'测试答复'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null,title:'生成测试'}},{type:'message_stop'}];
    return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
  };
})()`

const fixtures = [
  ['old-tea', 1, '我喜欢绿茶。'],
  ['old-city', 2, '我目前住在杭州。'],
  ['project', 3, '我正在开发蓝色风铃项目。'],
  ['forget', 4, '忘记所有记忆。'],
  ['secret', 5, '请记住 API Key: sk-syntheticcredentials'],
  ['excluded', 6, '我喜欢排除测试。'],
  ['refusal', 7, '我喜欢拒答测试。', 'CONTENT_FILTER'],
  ['stopped', 8, '我喜欢未完成测试。', 'INCOMPLETE'],
]
const archive = { 'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })) }
const index = fixtures.map(([id, day, text, status]) => {
  const time = `2026-10-0${day}T00:00:00Z`
  const summary = {
    id,
    title: `Synthetic ${id}`,
    pinned: false,
    inserted_at: time,
    updated_at: time,
    message_count: 2,
  }
  const common = {
    thinking_enabled: false,
    search_enabled: false,
    accumulated_token_usage: 0,
    inserted_at: time,
  }
  archive[`chat_sessions/${id}.json`] = strToU8(
    JSON.stringify({
      ...summary,
      current_message_id: 2,
      messages: [
        {
          ...common,
          id: 1,
          parent_id: null,
          role: 'USER',
          status: 'FINISHED',
          fragments: [{ type: 'REQUEST', content: text }],
        },
        {
          ...common,
          id: 2,
          parent_id: 1,
          role: 'ASSISTANT',
          status: status ?? 'FINISHED',
          fragments: [{ type: 'RESPONSE', content: 'ASSISTANT_SENTINEL' }],
        },
      ],
    })
  )
  return summary
})
archive['chat_session_index.json'] = strToU8(JSON.stringify(index))
const zip = Buffer.from(zipSync(archive)).toString('base64')
try {
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mockedApi })
  await wait('!!window.ohMyDeepSeekBack')
  await cdp.evaluate(`(async()=>{
    window.OhMyDeepSeekAndroid.writeApiKey('synthetic-history-key');
    localStorage.setItem('chat-demo:locale','zh-CN');localStorage.setItem('chat-demo:theme-preference','light');
    localStorage.setItem('ohmy:memory-auto','false');localStorage.setItem('ohmy:memory-history','false');
    const db=await new Promise(resolve=>{const r=indexedDB.open('ohmy-deepseek-memory');r.onsuccess=()=>resolve(r.result)});
    const now=Date.parse('2026-11-01T00:00:00Z');const tx=db.transaction(['saved','excluded'],'readwrite');
    tx.objectStore('saved').put({id:'current-tea',text:'用户现在喜欢红茶。',key:'preferences.tea',origin:'automatic',createdAt:now,updatedAt:now});
    tx.objectStore('saved').put({id:'manual-city',text:'用户目前住在南京。',key:'profile.city',origin:'manual',createdAt:1,updatedAt:1});
    tx.objectStore('excluded').put({id:'excluded'});await new Promise(resolve=>tx.oncomplete=resolve);db.close();
  })()`)
  await cdp.send('Page.reload')
  await wait(`!!window.__historyCalls && document.documentElement.lang==='zh-CN'`)
  await cdp.evaluate(`document.querySelector('button[aria-label="打开边栏"]')?.click()`)
  await click('设置')
  await wait(`[...document.querySelectorAll('[role="tab"]')].some(t=>t.textContent==='数据管理')`)
  await cdp.evaluate(
    `[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='数据管理').click()`
  )
  await wait(`!!document.querySelector('input[accept*="application/zip"]')`)
  await cdp.evaluate(`(()=>{
    const bytes=Uint8Array.from(atob('${zip}'),char=>char.charCodeAt(0));
    const x=new DataTransfer();x.items.add(new File([bytes],'memory-fixture.zip',{type:'application/zip'}));
    const field=document.querySelector('input[accept*="application/zip"]');field.files=x.files;field.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  await click('确认导入')
  await wait(`document.body.innerText.includes('已导入 8 个对话')`)
  assert.equal(await cdp.evaluate('window.__historyCalls.length'), 0)
  await click('从历史生成记忆')
  await phase('ready')
  assert.ok(await cdp.evaluate(`document.body.innerText.includes('3 轮聊天可整理')`))
  assert.equal(await cdp.evaluate('window.__historyCalls.length'), 0)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 360,
    height: 780,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await delay(300)
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('evidence/local', { recursive: true })
  writeFileSync('evidence/local/history-memory-confirm.png', Buffer.from(screenshot.data, 'base64'))
  console.log(
    'PASS ZIP import and local scan are free; exclusions, secrets, forget requests and incomplete turns are filtered'
  )

  await click('开始生成')
  await wait('window.__held===true')
  await click('取消任务')
  await cdp.evaluate('window.__release()')
  await phase('stopped')
  assert.deepEqual((await saved()).map((row) => row.id).sort(), ['current-tea', 'manual-city'])
  const calls = await cdp.evaluate('window.__historyCalls')
  assert.deepEqual(
    calls.map((call) => call.payload.user),
    ['我喜欢绿茶。', '我目前住在杭州。', '我正在开发蓝色风铃项目。']
  )
  assert.ok(
    calls.every(
      ({ body }) =>
        body.model === 'deepseek-flash' &&
        body.max_tokens === 1000 &&
        !JSON.stringify(body).includes('ASSISTANT_SENTINEL')
    )
  )
  console.log(
    'PASS paid path uses the live extractor payload; older and manual memories are protected, and late cancelled results are discarded'
  )

  await cdp.evaluate('window.__hold=false')
  await click('检查剩余')
  await phase('ready')
  assert.ok(await cdp.evaluate(`document.body.innerText.includes('1 轮聊天可整理')`))
  await click('开始生成')
  await phase('done')
  const generated = (await saved()).find((row) => row.key === 'project.name')
  assert.equal(generated.origin, 'automatic')
  assert.equal(generated.sourceSessionId, 'project')
  assert.equal(generated.sourceMessageId, '1')
  assert.equal(generated.updatedAt, Date.parse('2026-10-03T00:00:00Z'))
  await click('检查剩余')
  await phase('ready')
  assert.ok(await cdp.evaluate(`document.body.innerText.includes('目前没有可整理的旧消息')`))
  assert.equal(await cdp.evaluate('window.__historyCalls.length'), 4)
  console.log(
    'PASS a new batch resumes from the unfinished turn and carries provenance without duplicates'
  )

  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await wait(`document.querySelectorAll('[role="dialog"]').length===1`)
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await wait(`!document.querySelector('[role="dialog"]')`)
  await cdp.evaluate(
    `(()=>{const el=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'继续我的蓝色风铃项目');el.dispatchEvent(new Event('input',{bubbles:true}));})()`
  )
  await cdp.evaluate(`document.querySelector('button[aria-label="发送"]').click()`)
  await wait('window.__chatCalls.length===1')
  assert.ok(await cdp.evaluate(`window.__chatCalls[0].system.includes('用户在开发蓝色风铃项目。')`))
  console.log(
    'PASS generated history memory is recalled in a real chat request with history references and auto extraction off'
  )
} finally {
  await cdp.evaluate('window.__release?.()').catch(() => {})
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  cdp.close()
}
