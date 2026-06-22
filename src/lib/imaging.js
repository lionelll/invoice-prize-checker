import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

let detectorWorker
let detectorRequestId = 0
const detectorRequests = new Map()

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('处理已取消', 'AbortError')
}

function getDetectorWorker() {
  if (!detectorWorker) {
    detectorWorker = new Worker(new URL('./opencv.worker.js', import.meta.url), { type: 'module' })
    detectorWorker.onmessage = ({ data }) => {
      const request = detectorRequests.get(data.id)
      if (!request) return
      detectorRequests.delete(data.id)
      if (data.error) request.reject(new Error(data.error))
      else request.resolve(data.regions)
    }
    detectorWorker.onerror = (event) => {
      detectorRequests.forEach((request) => request.reject(new Error(event.message || 'OpenCV Worker 加载失败')))
      detectorRequests.clear()
      detectorWorker?.terminate()
      detectorWorker = null
    }
  }
  return detectorWorker
}

function detectWithWorker(imageData, signal) {
  return new Promise((resolve, reject) => {
    const id = ++detectorRequestId
    const worker = getDetectorWorker()
    const timeout = window.setTimeout(() => {
      detectorRequests.delete(id)
      reject(new Error('OpenCV 区域检测超时'))
    }, 45000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      signal?.removeEventListener('abort', abortListener)
    }
    const abortListener = () => {
      detectorRequests.delete(id)
      cleanup()
      reject(new DOMException('处理已取消', 'AbortError'))
    }
    signal?.addEventListener('abort', abortListener, { once: true })
    detectorRequests.set(id, {
      resolve: (regions) => { cleanup(); resolve(regions) },
      reject: (error) => { cleanup(); reject(error) },
    })
    worker.postMessage({ id, imageData }, [imageData.data.buffer])
  })
}

export async function sha256File(file) {
  const bytes = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function canvasToPreview(canvas, quality = 0.82) {
  return canvas.toDataURL('image/jpeg', quality)
}

async function imageFileToCanvas(file) {
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error(`无法读取图片：${file.name}`))
      element.src = url
    })
    const maxSide = 3200
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function pdfFileToCanvases(file, signal) {
  const data = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pages = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    throwIfAborted(signal)
    const page = await pdf.getPage(pageNumber)
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(2, 3000 / Math.max(baseViewport.width, baseViewport.height))
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport }).promise
    pages.push({ canvas, page: pageNumber })
  }
  return pages
}

function regionId(assetId, index) {
  return `${assetId}-region-${index + 1}`
}

export function createFullRegion(asset, detectionMethod = 'fallback') {
  return {
    id: regionId(asset.id, 0),
    x: 0,
    y: 0,
    width: asset.width,
    height: asset.height,
    rotation: 0,
    detectionMethod,
    confidence: detectionMethod === 'manual' ? 1 : 0.35,
  }
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union = a.width * a.height + b.width * b.height - intersection
  return union ? intersection / union : 0
}

function removeOverlaps(regions) {
  const accepted = []
  for (const region of regions.sort((a, b) => b.width * b.height - a.width * a.height)) {
    if (!accepted.some((entry) => intersectionOverUnion(entry, region) > 0.72)) accepted.push(region)
  }
  return accepted.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 20)
}

export async function detectInvoiceRegions(asset, signal) {
  throwIfAborted(signal)
  const maxDetectionSide = 1500
  const detectionScale = Math.min(1, maxDetectionSide / Math.max(asset.width, asset.height))
  const detectionCanvas = document.createElement('canvas')
  detectionCanvas.width = Math.max(1, Math.round(asset.width * detectionScale))
  detectionCanvas.height = Math.max(1, Math.round(asset.height * detectionScale))
  const detectionContext = detectionCanvas.getContext('2d', { willReadFrequently: true })
  detectionContext.drawImage(asset.canvas, 0, 0, detectionCanvas.width, detectionCanvas.height)
  try {
    const imageData = detectionContext.getImageData(0, 0, detectionCanvas.width, detectionCanvas.height)
    const candidates = await detectWithWorker(imageData, signal)
    const inverse = 1 / detectionScale
    const regions = removeOverlaps(candidates.map((candidate, index) => ({
      id: regionId(asset.id, index),
      x: Math.max(0, Math.round(candidate.x * inverse)),
      y: Math.max(0, Math.round(candidate.y * inverse)),
      width: Math.min(asset.width, Math.round(candidate.width * inverse)),
      height: Math.min(asset.height, Math.round(candidate.height * inverse)),
      rotation: candidate.rotation || 0,
      detectionMethod: 'opencv',
      confidence: candidate.confidence,
    })))
    return regions.length ? regions : [createFullRegion(asset)]
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    console.warn('OpenCV 区域检测失败，使用整图识别。', error)
    return [createFullRegion(asset)]
  }
}

export async function prepareSourceAssets(files, { detectRegions = true, onProgress, signal } = {}) {
  const assets = []
  const detectionCache = new Map()
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    throwIfAborted(signal)
    const file = files[fileIndex]
    onProgress?.({ status: '正在计算文件指纹', progress: fileIndex / Math.max(1, files.length), sourceName: file.name })
    const fileHash = await sha256File(file)
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
    const pages = isPdf ? await pdfFileToCanvases(file, signal) : [{ canvas: await imageFileToCanvas(file), page: 1 }]
    for (const pageEntry of pages) {
      throwIfAborted(signal)
      const asset = {
        id: `asset-${fileIndex}-${pageEntry.page}-${fileHash.slice(0, 10)}`,
        fileId: `file-${fileIndex}-${fileHash.slice(0, 10)}`,
        sourceName: file.name,
        page: pageEntry.page,
        fileHash,
        canvas: pageEntry.canvas,
        previewUrl: canvasToPreview(pageEntry.canvas),
        width: pageEntry.canvas.width,
        height: pageEntry.canvas.height,
        regions: [],
      }
      const cacheKey = `${fileHash}:${pageEntry.page}`
      if (detectRegions && detectionCache.has(cacheKey)) {
        asset.regions = detectionCache.get(cacheKey).map((region, index) => ({ ...region, id: regionId(asset.id, index) }))
      } else if (detectRegions) {
        onProgress?.({ status: '正在检测发票区域', progress: fileIndex / Math.max(1, files.length), sourceName: file.name })
        asset.regions = await detectInvoiceRegions(asset, signal)
        detectionCache.set(cacheKey, asset.regions.map(({ id, ...region }) => region))
      } else {
        asset.regions = [createFullRegion(asset)]
      }
      assets.push(asset)
    }
    onProgress?.({ status: '文件预处理完成', progress: (fileIndex + 1) / files.length, sourceName: file.name })
  }
  return assets
}

export function calculateDHash(canvas) {
  const sample = document.createElement('canvas')
  sample.width = 9
  sample.height = 8
  const context = sample.getContext('2d', { willReadFrequently: true })
  context.drawImage(canvas, 0, 0, 9, 8)
  const pixels = context.getImageData(0, 0, 9, 8).data
  let hash = 0n
  let bit = 0n
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (pixels[(y * 9 + x) * 4] * 299 + pixels[(y * 9 + x) * 4 + 1] * 587 + pixels[(y * 9 + x) * 4 + 2] * 114) / 1000
      const rightIndex = (y * 9 + x + 1) * 4
      const right = (pixels[rightIndex] * 299 + pixels[rightIndex + 1] * 587 + pixels[rightIndex + 2] * 114) / 1000
      if (left > right) hash |= 1n << bit
      bit += 1n
    }
  }
  return hash.toString(16).padStart(16, '0')
}

export function cropRegion(asset, region) {
  const x = Math.max(0, Math.round(region.x))
  const y = Math.max(0, Math.round(region.y))
  const width = Math.max(1, Math.min(asset.width - x, Math.round(region.width)))
  const height = Math.max(1, Math.min(asset.height - y, Math.round(region.height)))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(asset.canvas, x, y, width, height, 0, 0, width, height)
  const regionSignature = [x, y, width, height].map((value) => Math.round(value / 8) * 8).join(':')
  return {
    image: canvas,
    previewUrl: canvasToPreview(canvas, 0.86),
    perceptualHash: calculateDHash(canvas),
    aspectRatio: width / height,
    regionSignature,
    ocrKey: `${asset.fileHash}:${asset.page}:${regionSignature}`,
  }
}

export function buildRegionJobs(assets) {
  return assets.flatMap((asset) => asset.regions.map((region, regionIndex) => ({
    ...cropRegion(asset, region),
    sourceAssetId: asset.id,
    sourceName: asset.sourceName,
    page: asset.page,
    fileHash: asset.fileHash,
    regionId: region.id,
    regionIndex,
    regionCount: asset.regions.length,
    bbox: { x: region.x, y: region.y, width: region.width, height: region.height },
    detectionMethod: region.detectionMethod,
  })))
}

export function hammingDistanceHex(left, right) {
  if (!left || !right || left.length !== right.length) return Number.POSITIVE_INFINITY
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let count = 0
  while (value) {
    count += Number(value & 1n)
    value >>= 1n
  }
  return count
}
