import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, FileSearch, Plus, Trash2 } from 'lucide-react'
import DuplicateReview from './DuplicateReview'

const confidenceClass = (value) => value >= 75 ? 'good' : value >= 55 ? 'medium' : 'low'
const PAGE_SIZE = 50

export default function ReviewView({ invoices, prizes, setPrizes, duplicateGroups, onResolveDuplicate, onUpdateInvoice, onBack, onConfirm }) {
  const [invoicePage, setInvoicePage] = useState(1)
  const [prizePage, setPrizePage] = useState(1)
  const invoicePages = Math.max(1, Math.ceil(invoices.length / PAGE_SIZE))
  const prizePages = Math.max(1, Math.ceil(prizes.length / PAGE_SIZE))
  const visibleInvoices = useMemo(() => invoices.slice((invoicePage - 1) * PAGE_SIZE, invoicePage * PAGE_SIZE), [invoices, invoicePage])
  const visiblePrizes = useMemo(() => prizes.slice((prizePage - 1) * PAGE_SIZE, prizePage * PAGE_SIZE), [prizes, prizePage])
  const unresolvedDuplicates = duplicateGroups.filter((group) => group.status === 'unresolved').length
  const updateInvoice = (id, key, value) => onUpdateInvoice(id, {
    [key]: value,
    ...(key === 'invoiceNumber' ? { needsReview: !value, confidence: value ? 100 : 0 } : {}),
  })
  const updatePrize = (id, key, value) => setPrizes((items) => items.map((item) => item.id === id ? { ...item, [key]: value } : item))

  return (
    <main className="workspace review-workspace">
      <ProgressHeader title="识别内容" subtitle="请核对关键号码。OCR 结果可直接修改，确认后再进行中奖匹配。" />
      <div className="review-grid">
        <DuplicateReview groups={duplicateGroups} invoices={invoices} onResolve={onResolveDuplicate} />
        <section className="major-panel">
          <div className="panel-heading">
            <div><h2>发票识别结果</h2><p>共 {invoices.length} 张（含 PDF 分页）</p></div>
            <span className="review-count"><FileSearch size={17} /> {invoices.filter((item) => item.needsReview).length} 条需留意</span>
          </div>
          <div className="editable-table invoice-edit-table">
            <div className="editable-row editable-head"><span>来源</span><span>发票代码</span><span>发票号码</span><span>商户</span><span>日期</span><span>金额</span><span>置信度</span></div>
            {visibleInvoices.map((item) => (
              <div className="editable-row" key={item.id}>
                <span className="source-cell" title={item.sourceName}>{item.sourceName}{item.page > 1 ? ` · 第${item.page}页` : ''}{item.listItemIndex != null ? ` · 清单${item.listItemIndex + 1}` : ''}</span>
                <input aria-label="发票代码" value={item.invoiceCode || ''} onChange={(event) => updateInvoice(item.id, 'invoiceCode', event.target.value.replace(/\D/g, ''))} placeholder="选填" />
                <input aria-label="发票号码" value={item.invoiceNumber} onChange={(event) => updateInvoice(item.id, 'invoiceNumber', event.target.value.replace(/\D/g, ''))} placeholder="请输入号码" />
                <input aria-label="商户" value={item.merchant} onChange={(event) => updateInvoice(item.id, 'merchant', event.target.value)} placeholder="未识别" />
                <input aria-label="开票日期" value={item.date} onChange={(event) => updateInvoice(item.id, 'date', event.target.value)} placeholder="YYYY-MM-DD" />
                <input aria-label="金额" type="number" min="0" step="0.01" value={item.amount || ''} onChange={(event) => updateInvoice(item.id, 'amount', Number(event.target.value))} placeholder="0.00" />
                <span className={`confidence ${confidenceClass(item.confidence)}`}>{item.confidence}%</span>
              </div>
            ))}
          </div>
          {invoicePages > 1 && <Pagination page={invoicePage} pages={invoicePages} onChange={setInvoicePage} />}
          {!invoices.length && <EmptyText text="未识别出发票页面，请返回重新上传。" />}
        </section>

        <section className="major-panel">
          <div className="panel-heading">
            <div><h2>中奖号码识别结果</h2><p>已从中奖图片中提取 {prizes.length} 条候选号码</p></div>
            <button type="button" className="button button-secondary compact" onClick={() => setPrizes((items) => [...items, { id: `manual-${Date.now()}`, number: '', prize: '中奖', amount: 0, sourceName: '手动添加', confidence: 100 }])}><Plus size={16} />添加一条</button>
          </div>
          <div className="editable-table prize-edit-table">
            <div className="editable-row editable-head"><span>中奖号码</span><span>奖项</span><span>奖金</span><span>来源</span><span /></div>
            {visiblePrizes.map((item) => (
              <div className="editable-row" key={item.id}>
                <input aria-label="中奖号码" value={item.number} onChange={(event) => updatePrize(item.id, 'number', event.target.value.replace(/[^0-9*]/g, ''))} placeholder="可输入完整号或尾号" />
                <input aria-label="奖项" value={item.prize} onChange={(event) => updatePrize(item.id, 'prize', event.target.value)} />
                <input aria-label="奖金" type="number" min="0" step="0.01" value={item.amount || ''} onChange={(event) => updatePrize(item.id, 'amount', Number(event.target.value))} placeholder="0.00" />
                <span className="source-cell" title={item.sourceName}>{item.sourceName}</span>
                <button className="icon-button danger" type="button" aria-label="删除" onClick={() => setPrizes((items) => items.filter((entry) => entry.id !== item.id))}><Trash2 size={17} /></button>
              </div>
            ))}
          </div>
          {prizePages > 1 && <Pagination page={prizePage} pages={prizePages} onChange={setPrizePage} />}
          {!prizes.length && <EmptyText text="未自动识别到中奖号码。请添加号码后继续。" warning />}
        </section>
      </div>
      <div className="review-footer">
        <button className="button button-secondary" type="button" onClick={onBack}><ArrowLeft size={18} />返回上传</button>
        <div className="review-note"><AlertTriangle size={17} />{unresolvedDuplicates ? `还有 ${unresolvedDuplicates} 组重复候选需要决定` : '支持完整号码或不少于 6 位的尾号匹配'}</div>
        <button className="button button-primary" type="button" disabled={!invoices.length || unresolvedDuplicates > 0 || !prizes.some((item) => item.number.length >= 6)} onClick={onConfirm}><Check size={18} />确认并生成结果</button>
      </div>
    </main>
  )
}

function ProgressHeader({ title, subtitle }) {
  return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div></div>
}

function EmptyText({ text, warning }) {
  return <div className={`empty-inline ${warning ? 'warning' : ''}`}>{warning && <AlertTriangle size={18} />}{text}</div>
}

function Pagination({ page, pages, onChange }) {
  return <div className="pagination"><button disabled={page === 1} onClick={() => onChange(page - 1)}>上一页</button><span>{page} / {pages}</span><button disabled={page === pages} onClick={() => onChange(page + 1)}>下一页</button></div>
}
