import test from 'node:test'
import assert from 'node:assert/strict'
import { applyDuplicateDecision, buildDuplicateGroups, hammingDistanceHex, invoiceIdentityKey, recordsForStatistics } from '../src/lib/duplicates.js'

function record(id, overrides = {}) {
  return {
    id,
    sourceName: `${id}.png`,
    sourceAssetId: `asset-${id}`,
    invoiceCode: '',
    invoiceNumber: '',
    fileHash: `hash-${id}`,
    perceptualHash: '0000000000000000',
    aspectRatio: 1.5,
    regionSignature: '0:0:800:500',
    duplicateDecision: 'keep',
    ...overrides,
  }
}

test('电子发票和旧版发票生成稳定身份键', () => {
  assert.equal(invoiceIdentityKey(record('a', { invoiceNumber: '12345678901234567890' })), 'electronic:12345678901234567890')
  assert.equal(invoiceIdentityKey(record('b', { invoiceCode: '123456789012', invoiceNumber: '87654321' })), 'legacy:123456789012:87654321')
})

test('不同截图但发票号码相同时进入重复组', () => {
  const records = [
    record('a', { invoiceNumber: '12345678901234567890', perceptualHash: '0000000000000000' }),
    record('b', { invoiceNumber: '12345678901234567890', perceptualHash: 'ffffffffffffffff' }),
  ]
  const groups = buildDuplicateGroups(records)
  assert.equal(groups.length, 1)
  assert.ok(groups[0].reasons.some((reason) => reason.type === 'invoice_identity'))
})

test('改名但文件内容相同的记录进入重复组', () => {
  const records = [
    record('a', { fileHash: 'same-hash', perceptualHash: '0000000000000000' }),
    record('b', { fileHash: 'same-hash', perceptualHash: 'ffffffffffffffff' }),
  ]
  const groups = buildDuplicateGroups(records)
  assert.equal(groups.length, 1)
  assert.ok(groups[0].reasons.some((reason) => reason.type === 'file_hash'))
})

test('相同号码清单文件按清单行分别形成重复组', () => {
  const records = [
    record('a-1', { sourceName: 'a.png', fileHash: 'same', listItemIndex: 0, invoiceNumber: '12345678' }),
    record('a-2', { sourceName: 'a.png', fileHash: 'same', listItemIndex: 1, invoiceNumber: '87654321' }),
    record('b-1', { sourceName: 'b.png', fileHash: 'same', listItemIndex: 0, invoiceNumber: '12345678' }),
    record('b-2', { sourceName: 'b.png', fileHash: 'same', listItemIndex: 1, invoiceNumber: '87654321' }),
  ]
  const groups = buildDuplicateGroups(records)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.memberIds.length), [2, 2])
})

test('相似图片可人工判定为非重复并全部参与统计', () => {
  const records = [record('a'), record('b', { perceptualHash: '0000000000000003' })]
  const [group] = buildDuplicateGroups(records)
  assert.equal(hammingDistanceHex(records[0].perceptualHash, records[1].perceptualHash), 2)
  const resolved = applyDuplicateDecision(records, group, 'not_duplicate')
  assert.equal(recordsForStatistics(resolved).length, 2)
})

test('选择保留项后其余记录排除统计', () => {
  const records = [record('a', { invoiceNumber: '12345678' }), record('b', { invoiceNumber: '12345678' })]
  const [group] = buildDuplicateGroups(records)
  const resolved = applyDuplicateDecision(records, group, 'keeper', 'a')
  assert.equal(recordsForStatistics(resolved).length, 1)
  assert.equal(resolved.find((item) => item.id === 'b').duplicateKeeperId, 'a')
})

test('双方都没识别出号码、内容不同的相似图片不再误判为重复', () => {
  const records = [record('a'), record('b', { perceptualHash: '000000000000001f' })] // 距离 5
  assert.equal(hammingDistanceHex('0000000000000000', '000000000000001f'), 5)
  assert.equal(buildDuplicateGroups(records).length, 0)
})

test('有相同日期和金额佐证时相似图片仍判为重复', () => {
  const records = [
    record('a', { date: '2026-06-18', amount: 108.82 }),
    record('b', { date: '2026-06-18', amount: 108.82, perceptualHash: '000000000000001f' }), // 距离 5
  ]
  assert.equal(buildDuplicateGroups(records).length, 1)
})

test('100条唯一记录的重复检测不产生误分组', () => {
  const records = Array.from({ length: 100 }, (_, index) => record(`r-${index}`, {
    invoiceNumber: String(10000000 + index),
    perceptualHash: '',
    aspectRatio: 1 + index / 100,
  }))
  const groups = buildDuplicateGroups(records)
  assert.equal(groups.length, 0)
})
