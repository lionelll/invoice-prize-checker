import test from 'node:test'
import assert from 'node:assert/strict'
import { recognizeWithCache } from '../src/lib/recognitionProvider.js'

test('完全相同区域共享OCR，调整后只重识别变化区域', async () => {
  const calls = []
  const provider = {
    recognize: async (jobs) => {
      calls.push(jobs)
      return jobs.map((job) => ({ ...job, text: `text:${job.ocrKey}`, confidence: 90, blocks: [] }))
    },
  }
  const cache = new Map()
  const firstJobs = [
    { ocrKey: 'file-a:region-1', sourceName: 'a.png' },
    { ocrKey: 'file-a:region-1', sourceName: 'renamed.png' },
    { ocrKey: 'file-a:region-2', sourceName: 'a.png' },
  ]
  const first = await recognizeWithCache(provider, firstJobs, cache)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].length, 2)
  assert.equal(first.length, 3)
  assert.equal(first[0].text, first[1].text)

  const adjustedJobs = [
    { ocrKey: 'file-a:region-1-adjusted', sourceName: 'a.png' },
    { ocrKey: 'file-a:region-2', sourceName: 'a.png' },
  ]
  await recognizeWithCache(provider, adjustedJobs, cache)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].map((job) => job.ocrKey), ['file-a:region-1-adjusted'])
})

test('100文件批量任务可完成并在再次执行时全部命中缓存', async () => {
  let recognizedCount = 0
  const provider = {
    recognize: async (jobs) => {
      recognizedCount += jobs.length
      return jobs.map((job) => ({ ...job, text: job.sourceName, confidence: 88, blocks: [] }))
    },
  }
  const jobs = Array.from({ length: 100 }, (_, index) => ({
    ocrKey: `file-${index}:region-1`,
    sourceName: `invoice-${index}.png`,
  }))
  const cache = new Map()
  const first = await recognizeWithCache(provider, jobs, cache)
  const second = await recognizeWithCache(provider, jobs, cache)
  assert.equal(first.length, 100)
  assert.equal(second.length, 100)
  assert.equal(recognizedCount, 100)
  assert.equal(cache.size, 100)
})
