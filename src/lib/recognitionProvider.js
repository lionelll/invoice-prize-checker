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
  if (typeof window !== 'undefined' && window.innerWidth < 760) return 1 // 手机端省内存，单 worker
  const cores = navigator.hardwareConcurrency || 2
  return Math.max(1, Math.min(2, Math.floor(cores / 2)))
}

/** @returns {RecognitionProvider} */
export function createLocalRecognitionProvider({ concurrency = defaultConcurrency(), rotateAuto = false, keepBlocks = true } = {}) {
  let activeWorkers = []
  let warmingPromise = null
  let reporter = null
  let terminated = false

  const spawnWorkers = (count) => Promise.all(Array.from({ length: count }, (_, workerIndex) =>
    createWorker('chi_sim+eng', 1, {
      logger: (message) => reporter?.(workerIndex, message.status, message.progress),
    })))

  const ensureWorkers = async (count) => {
    if (!warmingPromise) warmingPromise = spawnWorkers(count)
    activeWorkers = await warmingPromise
    return activeWorkers
  }

  const disposeWorkers = async () => {
    const promise = warmingPromise
    warmingPromise = null
    reporter = null
    const workers = promise ? await promise.catch(() => activeWorkers) : activeWorkers
    activeWorkers = []
    await Promise.allSettled((workers || []).map((worker) => worker.terminate()))
  }

  return {
    // 预热：在图片预处理阶段就开始下载/初始化 OCR 模型，让这段耗时与预处理重叠，整体更快。
    warmUp(count = concurrency) {
      terminated = false
      if (!warmingPromise) {
        warmingPromise = spawnWorkers(Math.max(1, Math.min(count, 2)))
        warmingPromise.catch(() => { warmingPromise = null })
      }
    },

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
      let lastReportAt = 0
      let lastReportStatus = ''

      const report = (status, workerIndex, job, force = false) => {
        const now = Date.now()
        if (!force && status === lastReportStatus && now - lastReportAt < 120) return
        lastReportAt = now
        lastReportStatus = status
        const running = workerProgress.reduce((sum, value) => sum + value, 0)
        onProgress?.({
          status,
          progress: Math.min(1, (completed + running) / uniqueJobs.length),
          current: completed + 1,
          total: uniqueJobs.length,
          sourceName: job?.sourceName ?? '',
        })
      }
      reporter = (workerIndex, status, progress) => {
        if (workerIndex < workerCount) {
          workerProgress[workerIndex] = progress ?? 0
          report(status, workerIndex)
        }
      }

      // 复用 warmUp 预热好的 worker；若没预热则现场创建。模型加载已与预处理重叠，这里通常即刻就绪。
      const pool = await ensureWorkers(workerCount)
      const workers = pool.slice(0, workerCount)

      if (signal?.aborted || terminated) {
        await disposeWorkers()
        throw abortError()
      }

      const abortListener = () => {
        terminated = true
        disposeWorkers().catch(() => {})
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
          report('正在识别文字', workerIndex, job, true)
          let { data } = await worker.recognize(job.image, rotateAuto ? { rotateAuto: true } : {}, { text: true, blocks: keepBlocks })
          if (!rotateAuto && (!data.text?.trim() || data.confidence < 35)) {
            ;({ data } = await worker.recognize(job.image, { rotateAuto: true }, { text: true, blocks: keepBlocks }))
          }
          recognized.set(keyOf(job), {
            text: data.text,
            confidence: data.confidence,
            blocks: data.blocks ?? [],
          })
          completed += 1
          workerProgress[workerIndex] = 0
          report('识别完成', workerIndex, job, true)
        }
      }

      try {
        await Promise.all(workers.map(runWorker))
      } finally {
        signal?.removeEventListener('abort', abortListener)
        await disposeWorkers()
      }
      if (signal?.aborted || terminated) throw abortError()

      return jobs.map((job) => ({ ...job, ...(recognized.get(keyOf(job)) ?? {}) }))
    },

    async terminate() {
      terminated = true
      await disposeWorkers()
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
