let cvPromise

async function getOpenCv() {
  if (!cvPromise) cvPromise = import('@techstark/opencv-js').then(async ({ default: cvModule }) => {
    if (typeof cvModule?.then === 'function') return cvModule
    if (typeof cvModule?.Mat === 'function') return cvModule
    await new Promise((resolve) => { cvModule.onRuntimeInitialized = resolve })
    return cvModule
  })
  return cvPromise
}

function detectLightPaperRegions(imageData) {
  const { width, height, data } = imageData
  const step = Math.max(2, Math.ceil(Math.max(width, height) / 900))
  const gridWidth = Math.ceil(width / step)
  const gridHeight = Math.ceil(height / step)
  const total = gridWidth * gridHeight
  const visited = new Uint8Array(total)
  const queue = new Int32Array(total)
  const candidates = []
  const isPaper = (index) => {
    const x = (index % gridWidth) * step
    const y = Math.floor(index / gridWidth) * step
    const offset = (Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4
    const red = data[offset]
    const green = data[offset + 1]
    const blue = data[offset + 2]
    return red >= 220 && green >= 220 && blue >= 220 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 45
  }

  for (let start = 0; start < total; start += 1) {
    if (visited[start] || !isPaper(start)) {
      visited[start] = 1
      continue
    }
    let head = 0
    let tail = 1
    let count = 0
    let minX = gridWidth
    let maxX = 0
    let minY = gridHeight
    let maxY = 0
    queue[0] = start
    visited[start] = 1
    while (head < tail) {
      const current = queue[head++]
      const x = current % gridWidth
      const y = Math.floor(current / gridWidth)
      count += 1
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      const neighbours = [current - 1, current + 1, current - gridWidth, current + gridWidth]
      for (let index = 0; index < neighbours.length; index += 1) {
        const next = neighbours[index]
        if (next < 0 || next >= total || visited[next]) continue
        const nextX = next % gridWidth
        if ((index === 0 || index === 1) && Math.abs(nextX - x) !== 1) continue
        visited[next] = 1
        if (isPaper(next)) queue[tail++] = next
      }
    }
    const boxWidth = (maxX - minX + 1) * step
    const boxHeight = (maxY - minY + 1) * step
    const boxArea = boxWidth * boxHeight
    const areaRatio = boxArea / (width * height)
    const fillRatio = count / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1))
    const aspect = boxWidth / Math.max(1, boxHeight)
    if (areaRatio >= 0.04 && areaRatio <= 0.96 && boxWidth >= 120 && boxHeight >= 80 && fillRatio >= 0.42 && aspect >= 0.45 && aspect <= 3.4) {
      const padding = Math.max(4, step * 3)
      const x = Math.max(0, minX * step - padding)
      const y = Math.max(0, minY * step - padding)
      candidates.push({
        x,
        y,
        width: Math.min(width - x, boxWidth + padding * 2),
        height: Math.min(height - y, boxHeight + padding * 2),
        rotation: 0,
        confidence: Math.min(0.94, 0.58 + fillRatio * 0.35),
      })
    }
  }
  return candidates
}

self.onmessage = async ({ data }) => {
  const { id, imageData } = data
  try {
    const lightPaperRegions = detectLightPaperRegions(imageData)
    if (lightPaperRegions.length) {
      getOpenCv().catch(() => {})
      self.postMessage({ id, regions: lightPaperRegions })
      return
    }
    const cv = await getOpenCv()
    const src = cv.matFromImageData(imageData)
    const gray = new cv.Mat()
    const blurred = new cv.Mat()
    const edges = new cv.Mat()
    const contours = new cv.MatVector()
    const hierarchy = new cv.Mat()
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))
    const candidates = []
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
      cv.Canny(blurred, edges, 45, 135)
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel)
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
      const pageArea = imageData.width * imageData.height
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index)
        const approximation = new cv.Mat()
        try {
          const perimeter = cv.arcLength(contour, true)
          cv.approxPolyDP(contour, approximation, 0.025 * perimeter, true)
          const rect = cv.boundingRect(approximation)
          const area = Math.abs(cv.contourArea(contour))
          const rectArea = rect.width * rect.height
          const areaRatio = rectArea / pageArea
          const rectangularity = rectArea ? area / rectArea : 0
          const aspect = rect.width / Math.max(1, rect.height)
          if (
            approximation.rows >= 4 && approximation.rows <= 8 &&
            areaRatio >= 0.045 && areaRatio <= 0.98 &&
            rect.width >= 120 && rect.height >= 80 &&
            rectangularity >= 0.55 && aspect >= 0.45 && aspect <= 3.4
          ) candidates.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, rotation: 0, confidence: Math.min(0.98, 0.55 + rectangularity * 0.4) })
        } finally {
          contour.delete()
          approximation.delete()
        }
      }
    } finally {
      src.delete()
      gray.delete()
      blurred.delete()
      edges.delete()
      contours.delete()
      hierarchy.delete()
      kernel.delete()
    }
    self.postMessage({ id, regions: candidates })
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) })
  }
}
