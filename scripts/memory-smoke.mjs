import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { APP_ID, adb, connectWebView } from './webview-cdp.mjs'

assert.equal(
  APP_ID,
  'app.ohmydeepseek.android.importtest',
  'Refusing to modify the main application'
)
adb('shell', 'am', 'force-stop', APP_ID)
adb('shell', 'pm', 'clear', APP_ID)
adb('shell', 'am', 'start', '-n', `${APP_ID}/app.ohmydeepseek.android.MainActivity`)
await delay(1000)
let cdp = await connectWebView()
const passed = []
const check = (name) => {
  passed.push(name)
  console.log('PASS ' + name)
}
const wait = async (expression) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      if (await cdp.evaluate(expression)) return
    } catch (error) {
      if (attempt === 149) throw error
    }
    await delay(60)
  }
  throw Error('Timeout: ' + expression)
}
const click = (selector) =>
  cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
const input = (selector, value) =>
  cdp.evaluate(`(()=>{
  const element=document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,${JSON.stringify(value)});
  element.dispatchEvent(new Event('input',{bubbles:true}));
})()`)
const buttonText = (text) =>
  cdp.evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`
  )
const closeSettings = async () => {
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await wait(`!document.querySelector('[role="dialog"]')`)
}
const openMemory = async () => {
  if (!(await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`))) {
    await cdp.evaluate(`document.querySelector('button[aria-label*="管理记忆"]').click()`)
  } else {
    await cdp.evaluate(
      `[...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent==='记忆').click()`
    )
  }
  await wait(`!!document.querySelector('input[aria-label="使用保存的记忆"]')`)
}
const toggle = async (label, checked) => {
  const current = await cdp.evaluate(
    `document.querySelector('input[aria-label=${JSON.stringify(label)}]').checked`
  )
  if (current !== checked) await click(`input[aria-label="${label}"]`)
}
const newChat = async () => {
  await cdp.evaluate(`document.querySelector('button[aria-label="打开边栏"]')?.click()`)
  await delay(80)
  await cdp.evaluate(
    `(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='开启新对话');if(!button)throw Error('New chat button missing');button.click()})()`
  )
  await wait(`!!document.querySelector('textarea')`)
}
const send = async (text) => {
  const count = await cdp.evaluate('window.__mainCalls.length')
  await input('textarea', text)
  await click('button[aria-label="发送"]')
  await wait(`window.__mainCalls.length===${count + 1}`)
  await wait(
    `document.body.innerText.includes('测试答复：') && !document.querySelector('button[aria-label^="停止"]')`
  )
  return cdp.evaluate('window.__mainCalls.at(-1)')
}
const saved = () =>
  cdp.evaluate(`(async()=>{
  const db=await new Promise(resolve=>{const request=indexedDB.open('ohmy-deepseek-memory');request.onsuccess=()=>resolve(request.result)});
  const records=await new Promise(resolve=>{const request=db.transaction('saved').objectStore('saved').getAll();request.onsuccess=()=>resolve(request.result)});db.close();return records;
})()`)
const mock = async () =>
  cdp.evaluate(`(()=>{
  window.__mainCalls=[];window.__extractCalls=[];
  const original=window.fetch.bind(window);
  window.fetch=async(url,init={})=>{
    if(!String(url).startsWith('https://api.deepseek.com'))return original(url,init);
    if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}));
    const body=JSON.parse(init.body);
    if(String(url).endsWith('/chat/completions')){
      const payload=JSON.parse(body.messages.at(-1).content);window.__extractCalls.push(payload.user);
      if(window.__holdExtraction){
        window.__extractionWaiting=true;
        try{await new Promise((resolve,reject)=>{window.__releaseExtraction=resolve;init.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true})})}
        finally{window.__extractionWaiting=false;window.__holdExtraction=false;}
      }
      let result={memories:[],forget:[]};
      if(payload.user.includes('忘记'))result.forget=payload.existing.filter(item=>item.key==='preferences.tea').map(item=>item.id);
      else if(payload.user.includes('记住')&&/红茶|绿茶/.test(payload.user)){
        const previous=payload.existing.find(item=>item.key==='preferences.tea');
        result.memories=[{text:payload.user.includes('绿茶')?'用户平时喜欢喝绿茶。':'用户平时喜欢喝红茶。',key:'preferences.tea',...(previous?{replaces:previous.id}:{})}];
      }
      await new Promise(resolve=>setTimeout(resolve,120));
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}),{headers:{'content-type':'application/json'}});
    }
    if(!String(url).endsWith('/messages'))throw Error('Unexpected API in isolated test');
    window.__mainCalls.push(body);
    const result='测试答复：'+(body.system.includes('绿茶')?'绿茶':body.system.includes('红茶')?'红茶':body.system.includes('苍蓝花园')?'苍蓝花园':body.system.includes('Godot 4.7')?'Godot 4.7':'无额外记忆');
    const events=[{type:'message_start',message:{id:'fixture',model:'deepseek-flash'}},
      {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:{type:'text_delta',text:result}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null,title:'记忆测试'}},{type:'message_stop'}];
    const stream=events.map(event=>'event: '+event.type+'\\ndata: '+JSON.stringify(event)+'\\n\\n').join('');
    return new Response(stream,{headers:{'content-type':'text/event-stream'}});
  };
})()`)

try {
  await wait('!!window.ohMyDeepSeekBack')
  await cdp.evaluate(`(async()=>{
    window.OhMyDeepSeekAndroid.writeApiKey('ohmy-memory-test-key');
    const db=await new Promise(resolve=>{const request=indexedDB.open('chat-demo');request.onsuccess=()=>resolve(request.result)});
    const old=Date.now()-30*86400000;
    const sessions=[{id:'history-game',title:'像素游戏星海旧港',createdAt:old,updatedAt:old,messages:[
      {id:'user-history',role:'user',content:'我在做的像素游戏项目叫星海旧港，使用 Godot 4.7，引擎不使用 Unity。',files:[],createdAt:old},
      {id:'assistant-history',role:'assistant',model:'deepseek-flash',status:'done',prefix:true,blocks:[{type:'text',text:'可以继续做 Godot 游戏。'}],stopReason:'end_turn',createdAt:old+1}]},
      {id:'history-unrelated',title:'花卉记录',createdAt:old,updatedAt:old,messages:[{id:'user-flower',role:'user',content:'不相关的测试内容 NAZUNA_UNRELATED_SENTINEL',files:[],createdAt:old}]}];
    const tx=db.transaction(['sessions','sessionSummaries'],'readwrite');for(const session of sessions){tx.objectStore('sessions').put(session);tx.objectStore('sessionSummaries').put({id:session.id,title:session.title,createdAt:old,updatedAt:old,fileIds:[]})}
    await new Promise(resolve=>tx.oncomplete=resolve);db.close();
  })()`)
  await cdp.send('Page.reload')
  await delay(300)
  await wait('!!window.ohMyDeepSeekBack')
  await mock()
  await openMemory()
  await wait(`document.body.innerText.includes('已扫描 2 个本地对话')`)
  check('existing chats are indexed locally without any API calls')
  assert.equal(await cdp.evaluate('window.__extractCalls.length+window.__mainCalls.length'), 0)
  await buttonText('添加记忆')
  await input('textarea[aria-label="记忆内容"]', '我的长期学习项目代号是苍蓝花园。')
  await buttonText('保存记忆')
  await wait(`document.querySelectorAll('[role="dialog"]').length===1`)
  assert.ok(
    (await saved()).some((item) => item.text.includes('苍蓝花园') && item.origin === 'manual')
  )
  await buttonText('编辑记忆')
  await input(
    'textarea[aria-label="记忆内容"]',
    '我的长期学习项目代号是苍蓝花园，先做 Android 版。'
  )
  await buttonText('保存记忆')
  await wait(`document.querySelectorAll('[role="dialog"]').length===1`)
  assert.equal((await saved()).length, 1)
  assert.ok((await saved())[0].text.includes('先做 Android 版'))
  check('manual memory can be edited without creating a duplicate')
  await closeSettings()
  let call = await send('我的长期学习项目代号是什么？')
  assert.ok(call.system.includes('苍蓝花园'))
  await wait(`document.body.innerText.includes('记忆来源（')`)
  check('manual saved memory is injected into the real request and has a source entry')

  await send('记住，我平时喜欢喝红茶。')
  await wait(`document.body.innerText.includes('记忆已更新')`)
  assert.ok(
    (await saved()).some((item) => item.text.includes('红茶') && item.origin === 'automatic')
  )
  await newChat()
  call = await send('我平时喜欢喝哪种茶？')
  assert.ok(call.system.includes('红茶'))
  check('automatic memory survives into a different conversation')

  await send('现在改了，我更喜欢绿茶，记住这个变化。')
  await wait(`document.body.innerText.includes('记忆已更新')`)
  await wait(`!document.body.innerText.includes('正在整理记忆')`)
  const updated = (await saved()).filter((item) => item.key === 'preferences.tea')
  assert.equal(updated.length, 1)
  assert.ok(updated[0].text.includes('绿茶'))
  check('a newer preference replaces the previous automatic fact rather than duplicating it')

  await newChat()
  call = await send('之前的像素游戏星海旧港用了什么引擎？')
  assert.ok(call.system.includes('Godot 4.7'))
  assert.ok(!call.system.includes('NAZUNA_UNRELATED_SENTINEL'))
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.includes('记忆来源（')).click()`
  )
  await wait(
    `document.body.innerText.includes('像素游戏星海旧港') && document.body.innerText.includes('用户原话')`
  )
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await wait(`!document.querySelector('[role="dialog"]')`)
  check('relevant historical excerpts are recalled with provenance; unrelated history is not sent')

  await openMemory()
  await toggle('引用历史聊天', false)
  await closeSettings()
  await send('忘记我喜欢喝绿茶这条记忆。')
  await wait(`!document.body.innerText.includes('正在整理记忆')`)
  await wait(`document.body.innerText.includes('记忆已更新')`)
  assert.equal((await saved()).filter((item) => item.key === 'preferences.tea').length, 0)
  await newChat()
  call = await send('我平时喜欢喝哪种茶？')
  assert.ok(!call.system.includes('红茶') && !call.system.includes('绿茶'))
  check('explicit forget removes the saved item and disabled history cannot reintroduce it')

  await openMemory()
  await toggle('使用保存的记忆', false)
  await closeSettings()
  const extraBefore = await cdp.evaluate('window.__extractCalls.length')
  await newChat()
  call = await send('记住，我的其他项目代号是灰色城堡。')
  assert.ok(!call.system.includes('苍蓝花园'))
  await delay(250)
  assert.equal(await cdp.evaluate('window.__extractCalls.length'), extraBefore)
  assert.ok((await saved()).some((item) => item.text.includes('苍蓝花园')))
  check('turning memory off prevents reads and writes without deleting existing saved facts')

  await openMemory()
  await toggle('使用保存的记忆', true)
  await toggle('引用历史聊天', true)
  await closeSettings()
  await newChat()
  await openMemory()
  await toggle('新对话参与记忆', false)
  await closeSettings()
  const excludedBefore = await cdp.evaluate('window.__extractCalls.length')
  call = await send('记住，我的隔离项目叫琥珀星球。')
  assert.ok(!call.system.includes('苍蓝花园'))
  await delay(200)
  assert.equal(await cdp.evaluate('window.__extractCalls.length'), excludedBefore)
  await newChat()
  call = await send('琥珀星球的隔离项目是什么？')
  assert.ok(!call.system.includes('我的隔离项目叫琥珀星球'))
  check('an excluded chat neither reads nor creates memory and is not recalled later')

  await cdp.evaluate('window.__holdExtraction=true')
  await send('记住，我平时喜欢喝红茶。')
  await wait('window.__extractionWaiting === true')
  await openMemory()
  await buttonText('清空保存的记忆')
  await buttonText('删除')
  await wait('window.__extractionWaiting === false')
  assert.equal((await saved()).length, 0)
  await cdp.evaluate('window.__releaseExtraction?.()')
  await delay(150)
  assert.equal((await saved()).length, 0)
  check(
    'clearing saved memories cancels an in-flight extraction and cannot resurrect deleted facts'
  )

  const importFixture = async () =>
    cdp.evaluate(`(()=>{
    const data={format:'ohmy-deepseek-memory',version:1,saved:[{text:'我的合成备份偏好是青色。'}],excluded:[]};
    const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(data)],'synthetic-memory.json',{type:'application/json'}));
    const input=document.querySelector('input[accept=".json,application/json"]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  await importFixture()
  await wait(`document.body.innerText.includes('已添加 1 条记忆')`)
  await importFixture()
  await wait(`document.body.innerText.includes('已添加 0 条记忆')`)
  assert.equal((await saved()).length, 1)
  check('memory backups merge and deduplicate without overwriting existing entries')
  await closeSettings()

  const beforeRestart = (await saved()).map((memory) => memory.text)
  cdp.close()
  adb('shell', 'am', 'force-stop', APP_ID)
  adb('shell', 'am', 'start', '-n', `${APP_ID}/app.ohmydeepseek.android.MainActivity`)
  await delay(1000)
  cdp = await connectWebView()
  await wait('!!window.ohMyDeepSeekBack')
  assert.deepEqual(
    (await saved()).map((memory) => memory.text),
    beforeRestart
  )
  check('saved memories survive an Android process restart')
  await mock()
  await send('忘记所有记忆。')
  await wait(`document.body.innerText.includes('记忆已更新')`)
  assert.equal((await saved()).length, 0)
  assert.equal(await cdp.evaluate('window.__extractCalls.length'), 0)
  check('explicit forget-all clears saved memories locally without an extra API call')

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('evidence/local', { recursive: true })
  writeFileSync('evidence/local/memory-smoke.png', Buffer.from(screenshot.data, 'base64'))
  const errors = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown')
  assert.equal(errors.length, 0)
  check('memory-enabled conversation completes without uncaught JavaScript errors')
  writeFileSync(
    'evidence/local/memory-smoke.json',
    JSON.stringify({ responseSource: 'local fixtures', passed }, null, 2)
  )
} finally {
  cdp.close()
}
