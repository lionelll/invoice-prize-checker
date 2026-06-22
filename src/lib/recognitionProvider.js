import { createWorker } from 'tesseract.js'

/**
 * @typedef {Object} RecognitionProvider
 * @property {(jobs: Array<Object>, options?: Object) => Promise<Array<Object>>} recognize
 * @property {() => Promise<void>} terminate
 */

function abortError() {
  return new DOMException('识别已取消', 'AbortError')
}

function defaultConcurrency() {
  if (typeof navigator === 'undefined') return 1
  return navigator.hardwareConcurrency >= 6 && window.innerWidth >= 760 ? 2 : 1
}

/** @returns {RecognitionProvider} */
export function createLocalRecognitionProvider({ concurrency = defaultConcurrency() } = {}) {
  let activeWorkers = []
  let terminated = false

  return {
    async recognize(jobs, { onProgress, signal } = {}) {
      if (!jobs.length) return []
      terminated = false
      // 分组、写入、回读统一用同一个 key，避免 ocrKey 缺失时 get(undefined) 串台。
      const keyOf = (job) => job.ocrKey || `${job.sourceName}:${job.page}:${job.regionId}`
      const grouped = new Map()
      jobs.forEach((job) => {
        const key = keyOf(job)
        const group = grouped.get(key) ?? []
        group.push(job)
        grouped.set(key, group)
      })
      const uniqueJobs = [...grouped.values()].map((group) => group[0])
      const workerCount = Math.max(1, Math.min(concurrency, uniqueJobs.length, 2))
      const workerProgress = Array(workerCount).fill(0)
      let completed = 0

      const report = (status, workerIndex, job) => {
        const running = workerProgress.reduce((sum, value) => sum + value, 0)
        onProgress?.({
          status,
          progress: Math.min(1, (completed + running) / uniqueJobs.length),
          current: completed + 1,
          total: uniqueJobs.length,
          sourceName: job?.sourceName ?? '',
        })
      }

      activeWorkers = await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => createWorker('chi_sim+eng', 1, {
        logger: (message) => {
          workerProgress[workerIndex] = message.progress ?? 0
          report(message.status, workerIndex)
        },
      })))

      if (signal?.aborted || terminated) {
        await Promise.allSettled(activeWorkers.map((worker) => worker.terminate()))
        activeWorkers = []
        throw abortError()
      }

      const abortListener = () => {
        terminated = true
        activeWorkers.forEach((worker) => worker.terminate().catch(() => {}))
      }
      signal?.addEventListener('abort', abortListener, { once: true })

      let cursor = 0
      const recognized = new Map()
      const runWorker = async (worker, workerIndex) => {
        while (cursor < uniqueJobs.length) {
          if (signal?.aborted || terminated) throw abortError()
          const jobIndex = cursor
          cursor += 1
          const job = uniqueJobs[jobIndex]
          workerProgress[workerIndex] = 0
          report('正在识别文字', workerIndex, job)
          const { data } = await worker.recognize(job.image, { rotateAuto: true }, { text: true, blocks: true })
          recognized.set(keyOf(job), {
            text: data.text,
            confidence: data.confidence,
            blocks: data.blocks ?? [],
          })
          completed += 1
          workerProgress[workerIndex] = 0
          report('识别完成', workerIndex, job)
        }
      }

      try {
        await Promise.all(activeWorkers.map(runWorker))
      } finally {
        signal?.removeEventListener('abort', abortListener)
        await Promise.allSettled(activeWorkers.map((worker) => worker.terminate()))
        activeWorkers = []
      }
      if (signal?.aborted || terminated) throw abortError()

      return jobs.map((job) => ({ ...job, ...(recognized.get(keyOf(job)) ?? {}) }))
    },

    async terminate() {
      terminated = true
      await Promise.allSettled(activeWorkers.map((worker) => worker.terminate()))
      activeWorkers = []
    },
  }
}

export function createRecognitionProvider(type = 'local-ocr', options) {
  if (type !== 'local-ocr') throw new Error(`未配置识别服务：${type}`)
  return createLocalRecognitionProvider(options)
}

export async function recognizeWithCache(provider, jobs, cache = new Map(), { onProgress, signal } = {}) {
  const pendingByKey = new Map()
  jobs.forEach((job) => {
    if (!cache.has(job.ocrKey) && !pendingByKey.has(job.ocrKey)) pendingByKey.set(job.ocrKey, job)
  })
  const pending = [...pendingByKey.values()]
  const cachedCount = jobs.length - pending.length
  if (pending.length) {
    const recognized = await provider.recognize(pending, {
      signal,
      onProgress: (progress) => onProgress?.({
        ...progress,
        progress: jobs.length ? (cachedCount + progress.progress * pending.length) / jobs.length : 1,
        current: Math.min(jobs.length, cachedCount + progress.current),
        total: jobs.length,
      }),
    })
    recognized.forEach(({ text, confidence, blocks, ocrKey }) => cache.set(ocrKey, { text, confidence, blocks }))
  } else {
    onProgress?.({ status: '已复用识别结果', progress: 1, current: jobs.length, total: jobs.length })
  }
  return jobs.map((job) => ({ ...job, ...(cache.get(job.ocrKey) ?? {}) }))
}
