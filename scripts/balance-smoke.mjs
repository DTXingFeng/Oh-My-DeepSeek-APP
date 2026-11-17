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
adb('shell', 'am', 'start', '-W', '-n', `${APP_ID}/app.ohmydeepseek.android.MainActivity`)
const cdp = await connectWebView()
const passed = []
const check = (name) => {
  passed.push(name)
  console.log('PASS ' + name)
}
const wait = async (expression) => {
  for (let i = 0; i < 140; i++) {
    if (await cdp.evaluate(`!!document.body && (${expression})`)) return
    await delay(75)
  }
  throw Error('Timeout: ' + expression)
}
const clickText = (text) =>
  cdp.evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`
  )
const input = (selector, value) =>
  cdp.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`
  )
const refresh = async (mode, expected) => {
  await cdp.evaluate(`window.__balanceMode=${JSON.stringify(mode)};window.__offset+=5000`)
  await clickText('刷新余额')
  await wait(
    `document.body.innerText.includes(${JSON.stringify(expected)}) && ![...document.querySelectorAll('button')].some(b=>b.textContent.includes('正在刷新'))`
  )
}
const screenshot = async (name) => {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`evidence/local/balance-${name}.png`, Buffer.from(result.data, 'base64'))
}
const fixture = `(()=>{
 window.__balanceMode='normal';window.__balanceCalls=0;window.__offset=0;
 const now=Date.now.bind(Date);Date.now=()=>now()+window.__offset;
 const original=window.fetch.bind(window);
 window.fetch=async(url,init={})=>{
   if(!String(url).startsWith('https://api.deepseek.com'))return original(url,init);
   if(String(url).endsWith('/models'))return new Response(JSON.stringify({data:[{id:'deepseek-flash'}]}));
   if(!String(url).endsWith('/user/balance'))throw Error('Unexpected paid request blocked');
   window.__balanceCalls++;
   const mode=window.__balanceMode;
   if(mode==='network')throw new TypeError('synthetic offline');
   if(mode==='auth')return new Response('{}',{status:401});
   if(mode==='rate')return new Response('{}',{status:429});
   const total=mode==='low'?'3.20':mode==='zero'?'0.00':mode==='tiny'?'0.000001':mode==='held'?'99.99':mode==='huge'?'1234567890.12':mode==='malformed'?'not-a-number':'42.63';
   if(mode==='held'){window.__held=true;await new Promise(resolve=>window.__releaseBalance=resolve);window.__held=false;}
   else await new Promise(resolve=>setTimeout(resolve,100));
   return new Response(JSON.stringify({is_available:mode!=='zero',balance_infos:[{currency:'CNY',total_balance:total,topped_up_balance:mode==='normal'?'40.00':total,granted_balance:mode==='normal'?'2.63':'0.00'}]}));
 };
})()`
try {
  mkdirSync('evidence/local', { recursive: true })
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fixture })
  await cdp.send('Page.reload')
  await wait('!!window.ohMyDeepSeekBack && window.__balanceCalls===0')
  check('no API key means no balance requests')
  await cdp.evaluate(
    `window.OhMyDeepSeekAndroid.writeApiKey('balance-fixture-key-A');localStorage.setItem('ohmy:memory-enabled','false');localStorage.setItem('chat-demo:theme-preference','light')`
  )
  await cdp.send('Page.reload')
  await wait(`document.body.innerText.includes('42.63')`)
  assert.equal(await cdp.evaluate('window.__balanceCalls'), 1)
  check('initial balance loads once without invoking a model')
  await cdp.evaluate(`document.querySelector('button[aria-label^="查看账户余额"]').click()`)
  await wait(`document.body.innerText.includes('充值余额')`)
  assert.ok(
    await cdp.evaluate(
      `document.body.innerText.includes('40.00') && document.body.innerText.includes('2.63')`
    )
  )
  await screenshot('desktop')
  check('account details show total, topped-up, granted, and update time')

  await clickText('隐藏金额')
  assert.equal(
    await cdp.evaluate(
      `document.body.innerText.includes('42.63') || [...document.querySelectorAll('[aria-label],[title]')].some(e=>(e.getAttribute('aria-label')+e.getAttribute('title')).includes('42.63'))`
    ),
    false
  )
  await clickText('显示金额')
  check('hidden amounts are absent from visible text and accessible labels')
  await refresh('low', '余额已低于提醒阈值')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 892,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await delay(180)
  await screenshot('mobile-low')
  check('low balance has an inline warning without blocking the composer')

  await cdp.evaluate(`document.querySelector('details').open=true`)
  await input('input[aria-label="CNY 低余额提醒金额"]', '2')
  await cdp.evaluate(
    `document.querySelector('input[aria-label="CNY 低余额提醒金额"]').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))`
  )
  await wait(`!document.body.innerText.includes('余额已低于提醒阈值')`)
  assert.equal(
    await cdp.evaluate(`JSON.parse(localStorage.getItem('ohmy:balance-thresholds')).CNY`),
    2
  )
  check('custom warning thresholds take effect and persist as preferences')
  await cdp.evaluate(`document.querySelector('details').open=false`)
  await refresh('network', '余额查询超时或网络不可用')
  assert.ok(
    await cdp.evaluate(
      `document.body.innerText.includes('3.20') && document.body.innerText.includes('并非最新余额')`
    )
  )
  await screenshot('offline')
  check('network failure keeps the previous amount explicitly marked as stale')
  await refresh('malformed', '未能读取有效余额')
  assert.ok(await cdp.evaluate(`document.body.innerText.includes('3.20')`))
  check('invalid official response is not displayed as zero balance')
  await refresh('auth', '无法验证此 API Key')
  assert.equal(await cdp.evaluate(`document.body.innerText.includes('3.20')`), false)
  check('authentication failure removes the previously displayed amount')
  await refresh('zero', '当前余额不足')
  check('insufficient balance is explicit, with an official account recovery link')
  await refresh('tiny', '<¥0.01')
  check('small positive balances remain visibly different from zero')

  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await cdp.evaluate(`document.querySelector('button[aria-label*="管理记忆"]').click()`)
  await wait(`!!document.querySelector('[role="tab"]')`)
  await cdp.evaluate(
    `[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='数据管理').click()`
  )
  await wait(`!!document.querySelector('button[aria-label="修改 API Key"]')`)
  await cdp.evaluate(`document.querySelector('button[aria-label="修改 API Key"]').click()`)
  await input('input[type="password"]', 'balance-fixture-key-B')
  await cdp.evaluate(
    `window.__balanceMode='held';window.__offset+=5000;window.dispatchEvent(new Event('visibilitychange'));`
  )
  // Opening the balance dialog requests a fresh result only when the TTL expired.
  await cdp.evaluate(`window.__offset+=70000;document.dispatchEvent(new Event('visibilitychange'))`)
  await wait('window.__held===true')
  await cdp.evaluate(`window.__balanceMode='normal'`)
  await clickText('确定')
  await wait(`document.body.innerText.includes('42.63')`)
  await cdp.evaluate('window.__releaseBalance()')
  await delay(250)
  assert.equal(await cdp.evaluate(`document.body.innerText.includes('99.99')`), false)
  check('switching API keys cancels old data and rejects late responses from the previous key')

  const beforeUsage = await cdp.evaluate('window.__balanceCalls')
  await cdp.evaluate(
    `window.__offset+=7000;window.dispatchEvent(new Event('ohmydeepseek-usage'));window.dispatchEvent(new Event('ohmydeepseek-usage'))`
  )
  await wait(`window.__balanceCalls===${beforeUsage + 1}`)
  check('usage-triggered refresh is debounced into a single balance request')
  await wait(`document.body.innerText.includes('42.63')`)
  await delay(250)
  await cdp.evaluate(
    `window.__balanceMode='held';window.__offset+=70000;document.dispatchEvent(new Event('visibilitychange'))`
  )
  await wait('window.__held===true')
  const heldCalls = await cdp.evaluate('window.__balanceCalls')
  await cdp.evaluate(`window.__offset+=7000;window.dispatchEvent(new Event('ohmydeepseek-usage'))`)
  await delay(2100)
  assert.equal(await cdp.evaluate('window.__balanceCalls'), heldCalls)
  await cdp.evaluate(
    `window.__balanceMode='normal';window.__offset+=7000;window.__releaseBalance()`
  )
  await wait(
    `window.__balanceCalls===${heldCalls + 1} && document.body.innerText.includes('42.63')`
  )
  check('usage arriving during an in-flight query schedules a fresh result after it settles')
  await cdp.evaluate('window.ohMyDeepSeekBack()')
  await cdp.evaluate(`document.querySelector('button[aria-label^="查看账户余额"]').click()`)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await delay(200)
  assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > innerWidth`), false)
  await screenshot('narrow')
  await refresh('huge', '1,234,567,890.12')
  await cdp.evaluate(`document.querySelector('details').open=true`)
  assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > innerWidth`), false)
  assert.equal(
    await cdp.evaluate(
      `getComputedStyle(document.querySelector('section[aria-label="账户余额"]').parentElement).overflowY`
    ),
    'auto'
  )
  check('large amounts and expanded preferences stay inside a scrollable narrow dialog')
  await cdp.evaluate(`document.querySelector('details').open=false`)
  await refresh('normal', '42.63')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 892,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await cdp.evaluate(
    `document.body.setAttribute('data-ds-dark-theme','dark');document.body.classList.add('dark')`
  )
  await screenshot('dark')
  check('320 px mobile and dark mode render without horizontal overflow')
  await cdp.evaluate(
    `localStorage.setItem('chat-demo:locale','en-US');localStorage.setItem('chat-demo:theme-preference','dark')`
  )
  await cdp.send('Page.reload')
  await wait(`document.body.innerText.includes('42.63')`)
  await cdp.evaluate(`document.querySelector('button[aria-label^="View account balance"]').click()`)
  await wait(`document.body.innerText.includes('Topped up')`)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 740,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await screenshot('english')
  assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > innerWidth`), false)
  check('English labels and amounts remain usable at 320 px')
  assert.equal(cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').length, 0)
  check('all balance states complete without uncaught JavaScript errors')
  writeFileSync(
    'evidence/local/balance-smoke.json',
    JSON.stringify(
      { responseSource: 'local fixtures; no real account data or paid calls', passed },
      null,
      2
    )
  )
} finally {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  cdp.close()
}
