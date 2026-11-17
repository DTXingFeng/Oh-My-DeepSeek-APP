import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMemoryOverview,
  memorySnapshot,
  parseOverview,
  parseMemoryCorrection,
  sourceSnapshot,
  isMutedHistory,
} from '../src/services/memory/overview-model.ts'
const facts = () => [
  {
    id: 'location',
    key: 'profile.location',
    text: '用户居住在上海。',
    origin: 'automatic',
    createdAt: 1,
    updatedAt: 1,
    sourceSessionId: 'old-home',
    sourceMessageId: 'user-home',
  },
  {
    id: 'style',
    key: 'response.style',
    text: '用户偏好中文简短回答。',
    origin: 'manual',
    createdAt: 2,
    updatedAt: 2,
  },
]
test('local memory overview groups facts without extra model calls', () => {
  const entries = buildMemoryOverview(facts())
  assert.equal(entries.length, 2)
  assert.equal(entries[0].category, 'background')
  assert.equal(entries[1].category, 'preferences')
})
test('cached summary cannot survive changed, deleted, or muted original facts', () => {
  const saved = facts()
  saved[0].overview = {
    category: 'background',
    text: '住在上海，喜欢简短中文回复。',
    sourceIds: ['location', 'style'],
    snapshot: sourceSnapshot(saved, ['location', 'style']),
    generatedAt: 3,
  }
  assert.equal(buildMemoryOverview(saved).length, 1)
  saved[0].text = '用户现在居住在北京。'
  assert.ok(!buildMemoryOverview(saved).some((entry) => entry.text.includes('上海')))
  saved[0].muted = true
  assert.deepEqual(
    buildMemoryOverview(saved).map((entry) => entry.sourceIds),
    [['style']]
  )
  assert.equal(buildMemoryOverview([saved[1]]).length, 1)
})
test('model summaries must cover each known active source exactly once', () => {
  const saved = facts()
  const valid = {
    entries: saved.map((memory) => ({
      category: 'other',
      text: memory.text,
      sourceIds: [memory.id],
    })),
  }
  assert.equal(parseOverview(JSON.stringify(valid), saved).length, 2)
  for (const entries of [
    [],
    [valid.entries[0]],
    [valid.entries[0], valid.entries[0]],
    [{ category: 'other', text: '虚构', sourceIds: ['unknown'] }],
  ]) {
    assert.throws(() => parseOverview(JSON.stringify({ entries }), saved))
  }
})
test('correction proposals reject invented IDs, conflicting targets, and credentials', () => {
  const saved = facts(),
    snapshot = memorySnapshot(saved)
  assert.equal(
    parseMemoryCorrection(
      JSON.stringify({ changes: [{ id: 'location', text: '用户居住在北京。' }], forget: [] }),
      saved,
      snapshot
    ).changes[0].id,
    'location'
  )
  for (const proposal of [
    { changes: [{ id: 'unknown', text: '任意修改' }], forget: [] },
    { changes: [{ id: 'style', text: '新的偏好' }], forget: ['style'] },
    { changes: [], forget: ['unknown'] },
    { changes: [{ text: '密码是 secret' }], forget: [] },
  ])
    assert.throws(() => parseMemoryCorrection(JSON.stringify(proposal), saved, snapshot))
})
test('muting excludes the known source and exact matching excerpts, without deleting chats', () => {
  const muted = [{ ...facts()[0], muted: true }]
  assert.equal(isMutedHistory('我目前住上海', 'old-home', 'user-home', muted), true)
  assert.equal(isMutedHistory('原话：用户居住在上海。', 'another', 'message', muted), true)
  assert.equal(isMutedHistory('今天下雨', 'another', 'message', muted), false)
})
test('an omitted empty correction array is safe, but null or missing structure is rejected', () => {
  const saved = facts(),
    snapshot = memorySnapshot(saved)
  assert.deepEqual(
    parseMemoryCorrection(
      '{"changes":[{"id":"location","text":"用户居住在北京。"}]}',
      saved,
      snapshot
    ).forget,
    []
  )
  assert.deepEqual(parseMemoryCorrection('{"forget":["location"]}', saved, snapshot).changes, [])
  assert.throws(() => parseMemoryCorrection('{}', saved, snapshot))
  assert.throws(() => parseMemoryCorrection('{"changes":null,"forget":[]}', saved, snapshot))
})
test('snapshots invalidate changes and mute flags but ignore presentation-only metadata', () => {
  const saved = facts(),
    before = memorySnapshot(saved)
  assert.equal(
    memorySnapshot(saved.map((memory) => ({ ...memory, overview: { anything: true } }))),
    before
  )
  assert.notEqual(memorySnapshot(saved.map((memory) => ({ ...memory, muted: true }))), before)
})
