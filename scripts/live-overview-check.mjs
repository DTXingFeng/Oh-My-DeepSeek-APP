import './test-ts-resolver.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { APP_ID, connectWebView } from './webview-cdp.mjs'
const { OVERVIEW_PROMPT, CORRECTION_PROMPT } =
  await import('../src/services/memory/overview-prompts.ts')
const { parseOverview, parseMemoryCorrection, memorySnapshot } =
  await import('../src/services/memory/overview-model.ts')
assert.equal(APP_ID, 'app.ohmydeepseek.android')
assert.ok(
  process.argv.includes('--synthetic-paid-test'),
  'Opt in to two paid requests using synthetic memories only'
)
const cdp = await connectWebView()
const ask = (prompt, payload) =>
  cdp.evaluate(`(async()=>{
 const key=window.OhMyDeepSeekAndroid.readApiKey();if(!key)throw Error('No configured key');
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),24000);
 try{const r=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',signal:controller.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(
   {
     model: 'deepseek-flash',
     thinking: { type: 'disabled' },
     max_tokens: 4000,
     safety_check: { level: 'high' },
     messages: [
       { role: 'system', content: prompt },
       { role: 'user', content: JSON.stringify(payload) },
     ],
   }
 )})});if(!r.ok)return{status:r.status};const body=await r.json();return{status:r.status,content:body.choices?.[0]?.message?.content,finish:body.choices?.[0]?.finish_reason,usage:body.usage}}finally{clearTimeout(timer)}
})()`)
try {
  mkdirSync('evidence/local', { recursive: true })
  const saved = [
    {
      id: 'synthetic-location',
      key: 'profile.location',
      text: '用户在这份人工测试资料中居住在上海。',
      origin: 'manual',
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'synthetic-style',
      key: 'response.style',
      text: '用户在这份人工测试资料中偏好中文简短回答。',
      origin: 'manual',
      createdAt: 2,
      updatedAt: 2,
    },
    {
      id: 'synthetic-project',
      key: 'project.name',
      text: '用户在这份人工测试资料中的项目代号是蓝色风铃。',
      origin: 'manual',
      createdAt: 3,
      updatedAt: 3,
    },
  ]
  const summary = await ask(OVERVIEW_PROMPT, {
    locale: 'zh-CN',
    memories: saved.map(({ id, text, updatedAt }) => ({ id, text, updatedAt })),
  })
  assert.equal(summary.status, 200)
  assert.equal(summary.finish, 'stop')
  const entries = parseOverview(summary.content, saved)
  assert.ok(entries.some((entry) => entry.text.includes('蓝色风铃')))
  const correction = await ask(CORRECTION_PROMPT, {
    instruction: '在这份人工测试资料中，我现在住在北京，不是上海；其他资料保持不变。',
    memories: saved.map(({ id, text, updatedAt }) => ({ id, text, updatedAt })),
  })
  assert.equal(correction.status, 200)
  assert.equal(correction.finish, 'stop')
  writeFileSync(
    'evidence/local/live-overview-check.json',
    JSON.stringify(
      {
        source: 'actual DeepSeek requests using synthetic memories only; no app data modified',
        summary,
        correction,
      },
      null,
      2
    )
  )
  const proposal = parseMemoryCorrection(correction.content, saved, memorySnapshot(saved))
  assert.ok(
    proposal.changes.some(
      (change) => change.id === 'synthetic-location' && change.text.includes('北京')
    )
  )
  assert.equal(proposal.forget.length, 0)
  writeFileSync(
    'evidence/local/live-overview-check.json',
    JSON.stringify(
      {
        source:
          'two actual DeepSeek API requests, synthetic memories only; no private chats or app memory read or written',
        summary,
        correction,
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      passed: true,
      summaryEntries: entries.length,
      proposedChanges: proposal.changes.length,
      totalTokens: summary.usage.total_tokens + correction.usage.total_tokens,
    })
  )
} finally {
  cdp.close()
}
