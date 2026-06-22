function normalizedDigits(value = '') {
  return value.replace(/\D/g, '')
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

export function invoiceIdentityKey(invoice) {
  const number = normalizedDigits(invoice.invoiceNumber)
  const code = normalizedDigits(invoice.invoiceCode)
  if (number.length === 20) return `electronic:${number}`
  if (code && number) return `legacy:${code}:${number}`
  if (number.length >= 8) return `number:${number}`
  return ''
}

function regionSignature(record) {
  return record.regionSignature || [record.bbox?.x, record.bbox?.y, record.bbox?.width, record.bbox?.height].join(':')
}

function duplicateReasons(left, right) {
  const reasons = []
  const leftIdentity = invoiceIdentityKey(left)
  const rightIdentity = invoiceIdentityKey(right)
  if (leftIdentity && leftIdentity === rightIdentity) reasons.push({ type: 'invoice_identity', label: '发票号码相同', confidence: 1 })
  if (
    left.fileHash && left.fileHash === right.fileHash &&
    left.sourceName !== right.sourceName && regionSignature(left) === regionSignature(right) &&
    (left.listItemIndex ?? null) === (right.listItemIndex ?? null)
  ) reasons.push({ type: 'file_hash', label: '文件内容完全相同', confidence: 1 })
  const distance = hammingDistanceHex(left.perceptualHash, right.perceptualHash)
  const aspectDifference = Math.abs((left.aspectRatio || 1) - (right.aspectRatio || 1)) / Math.max(left.aspectRatio || 1, right.aspectRatio || 1)
  const identityConflict = leftIdentity && rightIdentity && leftIdentity !== rightIdentity
  const sameDateAndAmount = Boolean(left.date && right.date && left.date === right.date && Number(left.amount) > 0 && Number(left.amount) === Number(right.amount))
  const bothUnidentified = !leftIdentity && !rightIdentity
  let visualThreshold = 6
  if (identityConflict) {
    // 号码明确不同：除非几乎同图且日期金额一致，否则不判为重复。
    visualThreshold = distance <= 2 && sameDateAndAmount ? 6 : -1
  } else if (bothUnidentified && !sameDateAndAmount) {
    // 双方都没识别出号码、也没有日期+金额佐证：仅“几乎同一张图”才判重复，
    // 避免同一商家模板相近但内容不同的发票被误并、误删。
    visualThreshold = 2
  }
  if (distance <= visualThreshold && aspectDifference <= 0.1 && left.sourceAssetId !== right.sourceAssetId) {
    reasons.push({ type: 'visual_similarity', label: `图片高度相似（差异 ${distance}/64）`, confidence: 1 - distance / 64 })
  }
  return reasons
}

export function buildDuplicateGroups(records) {
  const parent = records.map((_, index) => index)
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]]
      index = parent[index]
    }
    return index
  }
  const union = (left, right) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }
  const pairReasons = new Map()
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      const reasons = duplicateReasons(records[left], records[right])
      if (reasons.length) {
        union(left, right)
        pairReasons.set(`${left}:${right}`, reasons)
      }
    }
  }
  const membersByRoot = new Map()
  records.forEach((record, index) => {
    const root = find(index)
    const members = membersByRoot.get(root) ?? []
    members.push({ record, index })
    membersByRoot.set(root, members)
  })
  let groupIndex = 0
  return [...membersByRoot.values()].filter((members) => members.length > 1).map((members) => {
    const reasons = new Map()
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const key = `${Math.min(members[left].index, members[right].index)}:${Math.max(members[left].index, members[right].index)}`
        ;(pairReasons.get(key) ?? []).forEach((reason) => reasons.set(reason.type, reason))
      }
    }
    groupIndex += 1
    return {
      id: `duplicate-group-${groupIndex}`,
      memberIds: members.map(({ record }) => record.id),
      reasons: [...reasons.values()],
      status: 'unresolved',
      keeperId: null,
    }
  })
}

export function applyDuplicateDecision(records, group, decision, keeperId = null) {
  const members = new Set(group.memberIds)
  return records.map((record) => {
    if (!members.has(record.id)) return record
    if (decision === 'not_duplicate') return { ...record, duplicateGroupId: null, duplicateDecision: 'not_duplicate', duplicateKeeperId: null }
    const keep = record.id === keeperId
    return {
      ...record,
      duplicateGroupId: group.id,
      duplicateDecision: keep ? 'keep' : 'exclude',
      duplicateKeeperId: keep ? record.id : keeperId,
    }
  })
}

export function recordsForStatistics(records) {
  return records.filter((record) => record.duplicateDecision !== 'exclude')
}
