import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { MEMORY_EXTRACTION_PROMPT, formatMemoryContext } from '../src/services/memory/prompts.ts'
import { parseExtraction } from '../src/services/memory/policy.ts'
import { APP_ID, connectWebView } from './webview-cdp.mjs'

assert.equal(APP_ID, 'app.ohmydeepseek.android')
assert.ok(
  process.argv.includes('--synthetic-paid-test'),
  'This performs at most two paid API calls using only synthetic data'
)
const cdp = await connectWebView()
const ask = async (body) =>
  cdp.evaluate(`(async()=>{
 const key=window.OhMyDeepSeekAndroid.readApiKey();if(!key)throw Error('No configured key');
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),24000);
 try{
  const response=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',signal:controller.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})});
  if(!response.ok)return {status:response.status,error:(await response.text()).slice(0,1600)};const data=await response.json();
  return {status:response.status,content:data.choices?.[0]?.message?.content,finish:data.choices?.[0]?.finish_reason,usage:data.usage};
 }finally{clearTimeout(timer)}
})()`)
try {
  const user = '记住：我的测试项目代号是蓝色风铃，我偏好用中文简短回答。这只是合成验收资料。'
  const extraction = await ask({
    model: 'deepseek-flash',
    thinking: { type: 'disabled' },
    max_tokens: 1000,
    safety_check: { level: 'high' },
    messages: [
      { role: 'system', content: MEMORY_EXTRACTION_PROMPT },
      { role: 'user', content: JSON.stringify({ user, existing: [] }) },
    ],
  })
  assert.equal(extraction.status, 200, JSON.stringify(extraction))
  assert.equal(extraction.finish, 'stop')
  const records = parseExtraction(extraction.content, [], user)
  assert.ok(records.memories.some((memory) => memory.text.includes('蓝色风铃')))
  const sources = records.memories.map((memory, index) => ({
    id: String(index),
    kind: 'saved',
    title: '自动记忆',
    excerpt: memory.text,
    updatedAt: Date.now(),
  }))
  const recall = await ask({
    model: 'deepseek-flash',
    thinking: { type: 'disabled' },
    max_tokens: 120,
    safety_check: { level: 'high' },
    messages: [
      {
        role: 'system',
        content: '该助手为DeepSeek，由深度求索公司创造。' + formatMemoryContext(sources),
      },
      { role: 'user', content: '我的测试项目代号是什么？只给出代号。' },
    ],
  })
  assert.equal(recall.status, 200)
  assert.ok(recall.content.includes('蓝色风铃'))
  mkdirSync('evidence/local', { recursive: true })
  writeFileSync(
    'evidence/local/live-memory-check.json',
    JSON.stringify(
      {
        source:
          'actual DeepSeek API, two synthetic requests, no private history used, no app data changed',
        extraction,
        recall,
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      passed: true,
      syntheticFacts: records.memories.length,
      recall: recall.content,
      extractionTokens: extraction.usage?.total_tokens,
      recallTokens: recall.usage?.total_tokens,
    })
  )
} finally {
  cdp.close()
}
