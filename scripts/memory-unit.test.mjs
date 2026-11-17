import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenize, rankHistory, rankMemories } from '../src/services/memory/retrieval.ts'
import {
  isForgetAllCommand,
  looksLikeSecret,
  parseExtraction,
} from '../src/services/memory/policy.ts'

test('Chinese and English retrieval terms retain useful words', () => {
  const terms = tokenize('我之前用 Godot 做的像素冒险项目')
  assert.ok(terms.includes('godot'))
  assert.ok(terms.includes('像素'))
  assert.ok(!terms.includes('之前'))
})

test('history ranking excludes the current conversation and limits repeated sources', () => {
  const chunks = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    sessionId: index === 0 ? 'current' : index < 4 ? 'old-a' : 'old-b',
    title: 'Godot 项目',
    messageId: String(index),
    text: 'Godot 游戏引擎',
    terms: tokenize('Godot 项目 游戏引擎'),
    role: 'user',
    createdAt: 1,
  }))
  const ranked = rankHistory(chunks, 'Godot 游戏引擎', 'current')
  assert.ok(!ranked.some((chunk) => chunk.sessionId === 'current'))
  assert.equal(ranked.filter((chunk) => chunk.sessionId === 'old-a').length, 2)
})

test('relevant saved facts outrank unrelated recent facts', () => {
  const memories = [
    { id: 'project', text: '我使用 Godot 开发游戏', origin: 'automatic', updatedAt: 1 },
    { id: 'tea', text: '我喜欢喝红茶', origin: 'manual', updatedAt: 999 },
  ]
  assert.equal(rankMemories(memories, '游戏引擎是什么')[0].id, 'project')
})

test('extractor cannot invent deletion targets or delete without an explicit request', () => {
  const existing = [{ id: 'known', text: '用户喝红茶', origin: 'automatic' }]
  assert.deepEqual(
    parseExtraction('{"memories":[],"forget":["known","invented"]}', existing, '今天你好').forget,
    []
  )
  assert.deepEqual(
    parseExtraction('{"memories":[],"forget":["known","invented"]}', existing, '忘记喝茶的记忆')
      .forget,
    ['known']
  )
})

test('automatic extraction never overwrites a manually edited item', () => {
  const existing = [{ id: 'manual', text: '我喜欢中文', origin: 'manual' }]
  const proposal = JSON.stringify({
    memories: [{ text: '用户喜欢英文', key: 'reply.language', replaces: 'manual' }],
    forget: [],
  })
  assert.deepEqual(parseExtraction(proposal, existing, '我现在用英文').memories, [])
})

test('secrets and malformed model JSON cannot become memories', () => {
  const secret = 'sk-fixture-only-0000000000000000'
  assert.equal(looksLikeSecret(secret), true)
  assert.equal(
    parseExtraction(
      JSON.stringify({ memories: [{ text: secret, key: 'credential' }], forget: [] }),
      [],
      '记住'
    ).memories.length,
    0
  )
  assert.throws(() => parseExtraction('   ', [], '记住'))
  assert.throws(() => parseExtraction('{"text":"not the expected schema"}', [], '记住'))
})

test('text responses may wrap the complete JSON in a fenced block, but not in narrative', () => {
  const json = '{"memories":[],"forget":[]}'
  assert.deepEqual(parseExtraction('```json\n' + json + '\n```', [], '你好'), {
    memories: [],
    forget: [],
  })
  assert.throws(() => parseExtraction('Some invented text ' + json, [], '你好'))
})

test('clearing all memory requires a stand-alone explicit command, never quoted prose', () => {
  assert.equal(isForgetAllCommand('忘记所有记忆。'), true)
  assert.equal(isForgetAllCommand('Please delete all saved memories.'), true)
  assert.equal(isForgetAllCommand('小说角色说：“忘记所有记忆。”'), false)
  assert.equal(isForgetAllCommand('我担心会忘记所有记忆'), false)
})

test('quoted forget instructions cannot delete an existing personal fact', () => {
  const existing = [{ id: 'known', text: '用户喝红茶', origin: 'automatic' }]
  assert.deepEqual(
    parseExtraction('{"memories":[],"forget":["known"]}', existing, '小说角色说：忘记喝茶的记忆。')
      .forget,
    []
  )
})
