const digitMap = Object.fromEntries('０１２３４５６７８９'.split('').map((d, i) => [d, String(i)]))

export function normalizeText(value = '') {
  return value
    .replace(/[０-９]/g, (d) => digitMap[d])
    .replace(/[，]/g, ',')
    .replace(/[：]/g, ':')
    .replace(/[￥]/g, '¥')
    .replace(/[—–]/g, '-')
}

const cleanNumber = (value = '') => value.replace(/[^0-9*]/g, '')

function scoreNumberCandidate(number, line, index) {
  let score = 0
  if (/发票号码|发票号|票号|invoice\s*no/i.test(line)) score += 8
  if (/号码|no\.?/i.test(line)) score += 3
  if (number.length === 20) score += 5
  if (number.length === 8) score += 4
  if (number.length >= 10 && number.length <= 12) score += 2
  if (/日期|校验码|机器编号|纳税人|统一社会信用/.test(line)) score -= 6
  if (/^(19|20)\d{6}$/.test(number)) score -= 8
  if (index < 8) score += 1
  return score
}

function collectInvoiceNumberCandidates(lines) {
  const candidates = []
  lines.forEach((line, index) => {
    const directMatches = [...line.matchAll(/(?:发票号码|发票号|票号|invoice\s*no\.?)[^0-9]{0,12}([0-9][0-9\s-]{6,24})/gi)]
    directMatches.forEach((direct) => {
      const number = cleanNumber(direct[1]).replace(/\*/g, '')
      if (number.length >= 8 && number.length <= 20) {
        candidates.push({ number, score: scoreNumberCandidate(number, line, index) + 10, lineIndex: index, direct: true })
      }
    })
    for (const match of line.matchAll(/(?<!\d)(\d[\d\s-]{6,24}\d)(?!\d)/g)) {
      const number = cleanNumber(match[1]).replace(/\*/g, '')
      if (number.length >= 8 && number.length <= 20) {
        candidates.push({ number, score: scoreNumberCandidate(number, line, index), lineIndex: index, direct: false })
      }
    }
  })
  const unique = new Map()
  candidates.forEach((candidate) => {
    const key = `${candidate.number}:${candidate.lineIndex}`
    const existing = unique.get(key)
    if (!existing || candidate.score > existing.score) unique.set(key, candidate)
  })
  return [...unique.values()].sort((a, b) => b.score - a.score || b.number.length - a.number.length)
}

function extractInvoiceNumber(lines) {
  return collectInvoiceNumberCandidates(lines)[0]?.number ?? ''
}

function extractInvoiceCode(lines, nearLineIndex = -1) {
  const ordered = nearLineIndex >= 0
    ? [...lines.slice(Math.max(0, nearLineIndex - 4), nearLineIndex + 5), ...lines]
    : lines
  for (const line of ordered) {
    const match = line.match(/(?:发票代码|票据代码)[^0-9]{0,10}(\d{10,12})/)
    if (match) return match[1]
  }
  return ''
}

function extractAmount(lines) {
  const candidates = []
  lines.forEach((line) => {
    const matches = [...line.matchAll(/(?:¥\s*)?([0-9]{1,9}(?:,[0-9]{3})*\.\d{2})/g)]
    matches.forEach((match) => {
      let score = 0
      if (/价税合计|小写|合计|总额/.test(line)) score += 8
      if (/金额/.test(line)) score += 2
      if (/税额|单价/.test(line)) score -= 3
      candidates.push({ value: Number(match[1].replace(/,/g, '')), score })
    })
  })
  return candidates.sort((a, b) => b.score - a.score || b.value - a.value)[0]?.value ?? 0
}

function extractDate(text) {
  const match = text.match(/(?:开票日期|日期)?[^0-9]{0,6}((?:19|20)\d{2})[年.\-/]\s*(\d{1,2})[月.\-/]\s*(\d{1,2})日?/)
  if (!match) return ''
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
}

function extractMerchant(lines) {
  const sellerStart = lines.findIndex((line) => /销售方|销方/.test(line))
  const searchable = sellerStart >= 0 ? lines.slice(sellerStart, sellerStart + 7) : lines
  for (const line of searchable) {
    const match = line.match(/(?:名称|销售方名称|销方名称)\s*[:：]?\s*([^:：]{3,40})/)
    if (match && !/购买方/.test(line)) return match[1].trim()
  }
  return ''
}

export function parseInvoiceDocument(doc, index) {
  const text = normalizeText(doc.text)
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  const invoiceNumber = extractInvoiceNumber(lines)
  const confidence = Math.round(doc.confidence || 0)
  return {
    id: `invoice-${index}-${Date.now()}`,
    sourceName: doc.sourceName,
    page: doc.page,
    invoiceCode: extractInvoiceCode(lines),
    invoiceNumber,
    merchant: extractMerchant(lines),
    date: extractDate(text),
    amount: extractAmount(lines),
    confidence,
    needsReview: !invoiceNumber || confidence < 55,
    rawText: text,
    previewUrl: doc.previewUrl,
    sourceAssetId: doc.sourceAssetId,
    regionId: doc.regionId,
    regionIndex: doc.regionIndex ?? 0,
    bbox: doc.bbox,
    fileHash: doc.fileHash,
    perceptualHash: doc.perceptualHash,
    aspectRatio: doc.aspectRatio,
    regionSignature: doc.regionSignature,
    detectionMethod: doc.detectionMethod,
    duplicateDecision: 'keep',
  }
}

function selectMultipleInvoiceCandidates(candidates, doc) {
  const byNumber = new Map()
  candidates.forEach((candidate) => {
    const existing = byNumber.get(candidate.number)
    if (!existing || candidate.score > existing.score) byNumber.set(candidate.number, candidate)
  })
  const unique = [...byNumber.values()]
  const direct = unique.filter((candidate) => candidate.direct)
  if (direct.length > 1) return direct
  const electronic = unique.filter((candidate) => candidate.number.length === 20 && candidate.score >= 3)
  if (electronic.length > 1) return electronic
  const eightDigitList = unique.filter((candidate) => candidate.number.length === 8 && candidate.score >= 3)
  if (doc.regionCount === 1 && ['fallback', 'manual'].includes(doc.detectionMethod) && eightDigitList.length > 1) return eightDigitList
  return unique.slice(0, 1)
}

export function parseInvoiceDocuments(doc, startIndex = 0) {
  const text = normalizeText(doc.text)
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  const candidates = selectMultipleInvoiceCandidates(collectInvoiceNumberCandidates(lines), doc)
  if (!candidates.length) return [parseInvoiceDocument(doc, startIndex)]
  return candidates.map((candidate, candidateIndex) => {
    const contextLines = lines.slice(Math.max(0, candidate.lineIndex - 3), candidate.lineIndex + 4)
    const contextText = contextLines.join('\n')
    const confidence = Math.round(doc.confidence || 0)
    return {
      id: `invoice-${startIndex + candidateIndex}-${doc.regionId || 'page'}-${candidateIndex}`,
      sourceName: doc.sourceName,
      page: doc.page,
      invoiceCode: extractInvoiceCode(lines, candidate.lineIndex),
      invoiceNumber: candidate.number,
      merchant: extractMerchant(contextLines) || extractMerchant(lines),
      date: extractDate(contextText) || extractDate(text),
      amount: extractAmount(contextLines) || (candidates.length === 1 ? extractAmount(lines) : 0),
      confidence,
      needsReview: confidence < 55 || candidate.score < 3,
      rawText: text,
      previewUrl: doc.previewUrl,
      textBlocks: doc.blocks ?? [],
      sourceAssetId: doc.sourceAssetId,
      regionId: doc.regionId,
      regionIndex: doc.regionIndex ?? 0,
      bbox: doc.bbox,
      fileHash: doc.fileHash,
      perceptualHash: doc.perceptualHash,
      aspectRatio: doc.aspectRatio,
      regionSignature: doc.regionSignature,
      detectionMethod: doc.detectionMethod,
      duplicateDecision: 'keep',
      listItemIndex: candidates.length > 1 ? candidateIndex : null,
    }
  })
}

function prizeLabelFromLine(line) {
  if (/未中奖|未获奖/.test(line)) return '未中奖'
  const prize = line.match(/([一二三四五六七八九十特][等奖项])/)
  if (prize) return prize[1]
  if (/中奖|获奖|抽中/.test(line)) return '中奖'
  return '奖项未识别'
}

const PRIZE_WIN_KEYWORD = /已中奖|中奖|获奖|抽中|奖金|奖品|奖励|[一二三四五六七八九十特][等奖]/
const PRIZE_LOSE_KEYWORD = /未中奖|未获奖|谢谢参与|提交失败|失败原因/

// 中奖截图里掺杂的订单号/手机号/税号等会造成误判，这里只认“像发票号”的数字：
// 20 位数电发票号、8 位旧版发票号、或带星号打码的尾号。
function isInvoiceLikeNumber(number, masked) {
  if (masked) return number.length >= 4 && number.length <= 12
  return number.length === 8 || (number.length >= 18 && number.length <= 20)
}

const PRIZE_KEYWORD = /奖金|奖品|中奖|抽中|获奖|奖励/
const INVOICE_AMOUNT_KEYWORD = /发票金额|开票金额|价税合计|小写|合计|税额|单价|发票/

function prizeAmountFromLine(line) {
  // 一行里可能同时出现“发票金额152.88元”和“奖品10元”，逐个金额打分后取最像奖金的那个。
  // 同时兼容“¥10 / ¥10.00”（无“元”）和“10元 / 10.00元”两种写法。
  const candidates = []
  for (const match of line.matchAll(/([^0-9¥￥]{0,10})[¥￥]?\s*([0-9]{1,7}(?:\.\d{1,2})?)\s*(元)?/g)) {
    const prefix = match[1] || ''
    const digits = match[2]
    if (/^\d{7,}$/.test(digits)) continue // 7 位以上整数多为发票号/订单号片段，不是奖金
    const value = Number(digits)
    if (!value) continue
    const hasYuan = Boolean(match[3])
    const hasCurrency = /[¥￥]/.test(match[0])
    const prizeKeyword = PRIZE_KEYWORD.test(prefix)
    // 既没有货币符号、也没有“元”、又不靠近奖金类关键词的纯数字，跳过（多半是号码/日期片段）。
    if (!prizeKeyword && !hasYuan && !hasCurrency) continue
    let score = 0
    if (prizeKeyword) score += 6
    if (hasCurrency) score += 2
    if (hasYuan) score += 1
    if (INVOICE_AMOUNT_KEYWORD.test(prefix)) score -= 8 // 这是发票自身金额，不是奖金
    candidates.push({ value, score })
  }
  candidates.sort((a, b) => b.score - a.score || a.value - b.value)
  return candidates.length && candidates[0].score > 0 ? candidates[0].value : 0
}

function collectPrizeNumbers(lines) {
  const numbers = []
  const seenPerLine = new Set()
  lines.forEach((line, idx) => {
    const found = [
      ...[...line.matchAll(/(?<!\d)(\d{6,20})(?!\d)/g)].map((m) => ({ value: cleanNumber(m[1]), masked: false })),
      ...[...line.matchAll(/\*{2,}\s*(\d{4,12})(?!\d)/g)].map((m) => ({ value: cleanNumber(m[1]), masked: true })),
    ]
    found.forEach(({ value, masked }) => {
      // 仅过滤“真的像日期”的数字（YYYYMM / YYYYMMDD 且月日合法），
      // 不再误伤以 19/20 开头的 8 位旧版发票号。
      if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])?$/.test(value)) return
      if (!isInvoiceLikeNumber(value, masked)) return // 过滤订单号/手机号/税号等无关数字
      const key = `${value}-${idx}`
      if (seenPerLine.has(key)) return
      seenPerLine.add(key)
      numbers.push({ number: value, idx })
    })
  })
  return numbers
}

// 发票号和它的奖项/奖金常常分布在不同的 OCR 行（支付宝/微信/京东/建行/抖音都如此），
// 因此按“条目块”读取上下文：取到本号码的距离不大于到相邻号码的行，
// 严格更近(exclusive)的行优先、等距(shared)的兜底，避免把相邻条目的中奖信息算到自己头上。
function analyzePrizeBlock(lines, numbers, k) {
  const here = numbers[k].idx
  const prev = k > 0 ? numbers[k - 1].idx : -Infinity
  const next = k < numbers.length - 1 ? numbers[k + 1].idx : Infinity
  const MAX_DISTANCE = 6
  const exclusive = []
  const shared = []
  for (let idx = 0; idx < lines.length; idx += 1) {
    const distSelf = Math.abs(idx - here)
    if (distSelf > MAX_DISTANCE) continue
    const distPrev = Math.abs(idx - prev)
    const distNext = Math.abs(idx - next)
    if (distSelf > distPrev || distSelf > distNext) continue // 这行离相邻发票更近，不属于本张
    ;(distSelf < distPrev && distSelf < distNext ? exclusive : shared).push({ distSelf, line: lines[idx] })
  }
  const ordered = [
    ...exclusive.sort((a, b) => a.distSelf - b.distSelf),
    ...shared.sort((a, b) => a.distSelf - b.distSelf),
  ]
  let amount = 0
  let label = ''
  let win = false
  let lose = false
  for (const { line } of ordered) {
    if (!win && !lose) {
      if (PRIZE_LOSE_KEYWORD.test(line)) lose = true
      else if (PRIZE_WIN_KEYWORD.test(line)) { win = true; label = prizeLabelFromLine(line) }
    }
    if (!amount) {
      const value = prizeAmountFromLine(line)
      if (value > 0) {
        amount = value
        win = true
        lose = false
        if (!label || label === '奖项未识别' || label === '未中奖') label = prizeLabelFromLine(line)
      }
    }
  }
  if (win && (!label || label === '奖项未识别' || label === '未中奖')) label = '中奖'
  return { amount, label: label || '奖项未识别', win, lose }
}

export function parsePrizeDocuments(docs) {
  const entries = []
  docs.forEach((doc, docIndex) => {
    const text = normalizeText(doc.text)
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
    const numbers = collectPrizeNumbers(lines)
    numbers.forEach((entry, k) => {
      const { amount, label, win, lose } = analyzePrizeBlock(lines, numbers, k)
      if (lose && !win) return // 明确未中奖/提交失败的，不作为中奖记录，避免误判中奖
      entries.push({
        id: `prize-${docIndex}-${entry.idx}-${entries.length}`,
        number: entry.number,
        prize: label,
        amount,
        sourceName: doc.sourceName,
        confidence: Math.round(doc.confidence || 0),
      })
    })
  })
  // 同一张发票号在多张截图里重复出现是“同一个中奖”，按号码去重（保留金额最大的那条），
  // 避免被 matchInvoices 误判成“匹配到多条中奖记录”。
  const byNumber = new Map()
  entries.forEach((entry) => {
    const existing = byNumber.get(entry.number)
    if (!existing || (entry.amount || 0) > (existing.amount || 0)) byNumber.set(entry.number, entry)
  })
  return [...byNumber.values()]
}

export function matchInvoices(invoices, prizes) {
  return invoices.map((invoice) => {
    const normalized = cleanNumber(invoice.invoiceNumber)
    const matches = normalized
      ? prizes.filter((prize) => {
          const target = cleanNumber(prize.number).replace(/\*/g, '')
          if (!target) return false
          if (normalized === target) return true
          // 仅在号码被打码/截断（长度不同）时才按尾号匹配，且尾号至少 8 位，降低不同发票尾号撞车的误配。
          const suffixLength = Math.min(normalized.length, target.length)
          return suffixLength >= 8 && normalized.slice(-suffixLength) === target.slice(-suffixLength)
        })
      : []
    const ambiguous = matches.length > 1
    return {
      ...invoice,
      match: matches[0] ?? null,
      status: !normalized || invoice.needsReview || ambiguous ? 'review' : matches.length ? 'won' : 'not-won',
      reason: !normalized
        ? '未识别到发票号码'
        : ambiguous
          ? '匹配到多条中奖记录'
          : invoice.confidence < 55
            ? '识别置信度较低'
            : '',
    }
  })
}
