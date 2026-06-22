import test from 'node:test'
import assert from 'node:assert/strict'
import { matchInvoices, normalizeText, parseInvoiceDocument, parseInvoiceDocuments, parsePrizeDocuments } from '../src/lib/parser.js'

test('规范化全角数字和中文标点', () => {
  assert.equal(normalizeText('发票号码：１２３４５６７８'), '发票号码:12345678')
})

test('从电子发票文字中提取关键字段', () => {
  const invoice = parseInvoiceDocument({
    sourceName: 'invoice.pdf',
    page: 1,
    confidence: 92,
    text: '电子发票\n发票号码：04400230011112345678\n开票日期：2026年06月18日\n销售方 名称：北京示例商贸有限公司\n价税合计（小写）¥180.00',
  }, 0)

  assert.equal(invoice.invoiceNumber, '04400230011112345678')
  assert.equal(invoice.date, '2026-06-18')
  assert.equal(invoice.merchant, '北京示例商贸有限公司')
  assert.equal(invoice.amount, 180)
  assert.equal(invoice.needsReview, false)
})

test('支持用不少于六位的中奖尾号匹配', () => {
  const invoice = parseInvoiceDocument({
    sourceName: 'invoice.png',
    page: 1,
    confidence: 95,
    text: '发票号码：04400230011112345678\n价税合计 ¥180.00',
  }, 0)
  const prizes = parsePrizeDocuments([{ sourceName: 'prize.png', confidence: 91, text: '三等奖 中奖号码 ****12345678 奖金 180元' }])
  const [result] = matchInvoices([invoice], prizes)

  assert.equal(prizes[0].number, '12345678')
  assert.equal(result.status, 'won')
  assert.equal(result.match.amount, 180)
})

test('奖金写成¥10不带“元”时也能识别金额', () => {
  const prizes = parsePrizeDocuments([
    { sourceName: 'wechat.png', confidence: 90, text: '26117000000585710721  中奖¥10' },
    { sourceName: 'alipay.png', confidence: 90, text: '已中奖·已发放 奖金 ¥10.00 26127000000239631631' },
  ])
  assert.equal(prizes[0].amount, 10)
  assert.equal(prizes[1].amount, 10)
})

test('同一行里不会把发票金额误当成奖金', () => {
  const [prize] = parsePrizeDocuments([
    { sourceName: 'ccb.png', confidence: 90, text: '发票号码26127000000234084871 发票金额152.88元 奖品10元现金' },
  ])
  assert.equal(prize.amount, 10)
})

test('只有号码和发票金额、没有奖金时金额为0', () => {
  const [prize] = parsePrizeDocuments([
    { sourceName: 'plain.png', confidence: 90, text: '发票号码 26127000000235353001 开票金额 135.62' },
  ])
  assert.equal(prize.amount, 0)
})

test('奖项/奖金与发票号分行时也能按条目读取（支付宝：奖金在下方）', () => {
  const prizes = parsePrizeDocuments([{
    sourceName: 'alipay.png', confidence: 90, text:
      '天津期选信息技术有限  未中奖\n发票号码：26127000000241266818\n发票金额：¥103.07\n' +
      '天津期选信息技术有限  已中奖·已发放\n发票号码：26127000000239631631\n发票金额：¥108.82\n开奖：2026-05-12  奖金 ¥10.00\n' +
      '天津优集客商业管理有  已中奖·已发放\n发票号码：26127000000195371032\n发票金额：¥189.25\n开奖：2026-05-11  奖金 ¥200.00',
  }])
  assert.equal(prizes.find((p) => p.number.endsWith('631631')).amount, 10)
  assert.equal(prizes.find((p) => p.number.endsWith('371032')).amount, 200)
  assert.equal(prizes.find((p) => p.number.endsWith('266818')), undefined) // 未中奖不计为中奖
})

test('奖金在发票号上方时也能正确归属（微信，两条不同金额）', () => {
  const prizes = parsePrizeDocuments([{
    sourceName: 'wechat.png', confidence: 90, text:
      '提交日期：2026-05-12  中奖¥50\n开票方：天津优集客\n发票号码：26127000000201023305\n发票金额：109.85元\n' +
      '提交日期：2026-05-08  中奖¥10\n开票方：天津期选\n发票号码：26127000000234084683\n发票金额：134.65元',
  }])
  assert.equal(prizes.find((p) => p.number.endsWith('023305')).amount, 50)
  assert.equal(prizes.find((p) => p.number.endsWith('084683')).amount, 10)
})

test('中奖截图里的订单号/提交失败不会被误判为中奖', () => {
  const prizes = parsePrizeDocuments([
    { sourceName: 'jd.png', confidence: 90, text: '¥10.00\n发票号码 26127000000235353001\n开票金额 135.62\n订单号 3466200012542928\n中奖时间 2026-05-09' },
    { sourceName: 'failed.png', confidence: 90, text: '提交失败\n发票号码：26117000000883599849\n失败原因：发票重复上传' },
  ])
  assert.equal(prizes.find((p) => p.number.endsWith('353001')).amount, 10)
  assert.equal(prizes.some((p) => p.number.includes('3466200012542928')), false) // 订单号被过滤
  assert.equal(prizes.some((p) => p.number.endsWith('599849')), false) // 提交失败不算中奖
})

test('同一发票号在多张截图重复出现时按一条中奖处理', () => {
  const invoice = parseInvoiceDocument({ sourceName: 'inv.pdf', page: 1, confidence: 95, text: '发票号码：26127000000239631631\n价税合计 ¥108.82' }, 0)
  const prizes = parsePrizeDocuments([
    { sourceName: 'a.png', confidence: 90, text: '已中奖 奖金 ¥10.00\n发票号码：26127000000239631631' },
    { sourceName: 'b.png', confidence: 90, text: '已中奖 奖金 ¥10.00\n发票号码：26127000000239631631' },
  ])
  const [result] = matchInvoices([invoice], prizes)
  assert.equal(result.status, 'won') // 不应因重复出现而误判“匹配到多条”
  assert.equal(result.match.amount, 10)
})

test('以19或20开头的8位旧版发票号不会被当作日期过滤掉', () => {
  const [prize] = parsePrizeDocuments([
    { sourceName: 'old.png', confidence: 90, text: '已中奖 奖金 ¥10\n发票号码 20991234' },
  ])
  assert.equal(prize.number, '20991234')
  assert.equal(prize.amount, 10)
})

test('号码缺失时进入人工确认而不是误判未中奖', () => {
  const invoice = parseInvoiceDocument({ sourceName: 'blur.png', page: 1, confidence: 35, text: '模糊发票' }, 0)
  const [result] = matchInvoices([invoice], [])

  assert.equal(result.status, 'review')
  assert.equal(result.reason, '未识别到发票号码')
})

test('一张号码清单图片生成多条发票记录', () => {
  const records = parseInvoiceDocuments({
    sourceName: 'list.png',
    page: 1,
    regionId: 'region-1',
    regionCount: 1,
    detectionMethod: 'fallback',
    confidence: 88,
    text: '中奖核对清单\n12345678\n87654321\n23456789',
  }, 0)

  assert.deepEqual(records.map((record) => record.invoiceNumber), ['12345678', '87654321', '23456789'])
  assert.deepEqual(records.map((record) => record.listItemIndex), [0, 1, 2])
})

test('同一区域只有一个号码时保持单条记录', () => {
  const records = parseInvoiceDocuments({
    sourceName: 'invoice.png',
    page: 1,
    regionId: 'region-1',
    regionCount: 1,
    detectionMethod: 'opencv',
    confidence: 90,
    text: '发票代码：123456789012\n发票号码：87654321\n开票日期：2026-06-22',
  }, 0)

  assert.equal(records.length, 1)
  assert.equal(records[0].invoiceCode, '123456789012')
  assert.equal(records[0].invoiceNumber, '87654321')
})
