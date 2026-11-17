import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { APP_ID, connectWebView } from './webview-cdp.mjs'
import { zipSync, strToU8 } from 'fflate'
import { mkdirSync, writeFileSync } from 'node:fs'

assert.equal(
  APP_ID,
  'app.ohmydeepseek.android.importtest',
  'Run in the isolated test installation only'
)
const cdp = await connectWebView()
const wait = async (expression) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await cdp.evaluate(expression)) return
    await delay(50)
  }
  throw Error('Timeout: ' + expression)
}
const openSettings = async () => {
  if (!(await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`))) {
    await cdp.evaluate(`document.querySelector('button[aria-label="打开边栏"]')?.click()`)
    await delay(100)
    await cdp.evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='设置').click()`
    )
  }
  await wait(`!!document.querySelector('[role="tab"]')`)
  await cdp.evaluate(
    `[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='数据管理').click()`
  )
}
try {
  await wait('!!window.ohMyDeepSeekBack')
  await openSettings()
  const timestamp = '2026-11-17T00:00:00Z'
  const archive = { 'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })) }
  const index = []
  for (let number = 1; number <= 3; number++) {
    const summary = {
      id: `feedback-${number}`,
      title: `Synthetic fixture ${number}`,
      pinned: false,
      inserted_at: timestamp,
      updated_at: timestamp,
      message_count: 1,
    }
    index.push(summary)
    archive[`chat_sessions/${summary.id}.json`] = strToU8(
      JSON.stringify({
        ...summary,
        current_message_id: 1,
        messages: [
          {
            id: 1,
            parent_id: null,
            role: 'USER',
            status: 'FINISHED',
            thinking_enabled: false,
            search_enabled: false,
            accumulated_token_usage: 0,
            inserted_at: timestamp,
            fragments: [{ type: 'REQUEST', content: 'Synthetic import fixture. '.repeat(500) }],
          },
        ],
      })
    )
  }
  archive['chat_session_index.json'] = strToU8(JSON.stringify(index))
  const fixture = Buffer.from(zipSync(archive, { level: 0 })).toString('base64')
  await cdp.evaluate(`(() => {
    const bytes=Uint8Array.from(atob('${fixture}'),char=>char.charCodeAt(0));
    const file=new File([bytes],'success-fixture.zip',{type:'application/zip'});
    const slice=file.slice.bind(file);
    file.slice=(...args)=>{const blob=slice(...args);const read=blob.arrayBuffer.bind(blob);blob.arrayBuffer=async()=>{await new Promise(resolve=>setTimeout(resolve,15));return read()};return blob};
    const transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('input[accept*="application/zip"]');input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    window.__importPhases=[];
    window.__importObserver=new MutationObserver(()=>{
      const label=document.querySelector('[role="status"] strong')?.textContent;
      if(label && !window.__importPhases.includes(label))window.__importPhases.push(label);
    });window.__importObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
  })()`)
  await wait(
    `document.querySelector('[role="dialog"]') && document.body.innerText.includes('success-fixture.zip')`
  )
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='确认导入').click()`
  )
  await wait(`document.body.innerText.includes('已导入 3 个对话')`)
  const phases = await cdp.evaluate('window.__importObserver.disconnect();window.__importPhases')
  assert.ok(phases.some((text) => text.includes('正在校验')))
  assert.ok(phases.some((text) => text.includes('正在读取归档目录')))
  assert.ok(phases.some((text) => text.includes('正在导入历史记录')))
  console.log(
    'PASS successful ZIP import reports real parsing phases and imported conversation count'
  )
  const countSessions = () =>
    cdp.evaluate(`(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('chat-demo');request.onsuccess=()=>resolve(request.result)});
    const count=await new Promise(resolve=>{const request=db.transaction('sessions').objectStore('sessions').count();request.onsuccess=()=>resolve(request.result)});
    db.close();return count;
  })()`)
  assert.equal(await countSessions(), 3)
  await cdp.evaluate(`(() => {
    const file=new File([new Uint8Array([80,75,3,4,0,0,0,0])],'feedback-test.zip',{type:'application/zip'});
    const slice=file.slice.bind(file);
    window.__importReadStarted=false;
    const gate=new Promise(resolve=>window.__releaseImportRead=resolve);
    file.slice=(...args)=>{
      const blob=slice(...args); const read=blob.arrayBuffer.bind(blob);
      blob.arrayBuffer=async()=>{window.__importReadStarted=true;await gate;return read()};return blob;
    };
    const transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('input[accept*="application/zip"]');
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent==='确认导入')`)
  await cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='确认导入').click()`
  )
  await wait('window.__importReadStarted === true')
  const pending = await cdp.evaluate(`({
    hasProgress:!!document.querySelector('[role="status"],[role="progressbar"]'),
    hasReadingText:/正在读取|正在校验|正在导入/.test(document.body.innerText),
    busyButton:[...document.querySelectorAll('button')].some(b=>b.disabled && /导入中/.test(b.textContent))
  })`)
  assert.ok(
    pending.hasProgress && pending.hasReadingText && pending.busyButton,
    'No visible feedback while history file reading is pending: ' + JSON.stringify(pending)
  )
  console.log('PASS visible import feedback while file I/O is pending')
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  assert.equal(await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`), true)
  console.log('PASS settings stays visible while the import is busy')
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  mkdirSync('evidence/local', { recursive: true })
  writeFileSync('evidence/local/import-feedback.png', Buffer.from(screenshot.data, 'base64'))
  await cdp.evaluate('window.__releaseImportRead()')
  await wait(`/导入失败/.test(document.body.innerText)`)
  assert.equal(await cdp.evaluate(`!!document.querySelector('[role="alert"]')`), true)
  assert.equal(await countSessions(), 3)
  console.log('PASS persistent error feedback after invalid archive; original data preserved')
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await wait(`!document.querySelector('[role="dialog"]')`)
  await openSettings()
  await wait(`!!document.querySelector('[role="alert"]')`)
  console.log('PASS import result persists after closing and reopening Settings')
} finally {
  await cdp.evaluate('window.__releaseImportRead?.()').catch(() => {})
  cdp.close()
}
