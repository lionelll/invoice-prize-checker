import { useMemo, useState } from 'react'
import { ArrowLeft, CheckCircle2, ChevronDown, Copy, Download, Eye, FileText, HelpCircle, Search, Trophy, XCircle } from 'lucide-react'

const statusMap = {
  won: { label: '已中奖', icon: CheckCircle2 },
  'not-won': { label: '未中奖', icon: XCircle },
  review: { label: '待确认', icon: HelpCircle },
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

export default function ResultsView({ results, allInvoices = results, onRestart, onUpdateStatus }) {
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const won = results.filter((item) => item.status === 'won')
  const review = results.filter((item) => item.status === 'review')
  const totalPrize = won.reduce((sum, item) => sum + Number(item.match?.amount || 0), 0)
  const wonPercent = results.length ? Math.round((won.length / results.length) * 100) : 0
  const pendingPercent = results.length ? Math.round((review.length / results.length) * 100) : 0
  const notWonPercent = Math.max(0, 100 - wonPercent - pendingPercent)
  const excludedInvoices = allInvoices.filter((item) => item.duplicateDecision === 'exclude')
  const filteredResults = useMemo(() => results.filter((item) => {
    const statusMatches = filter === 'all' || item.status === filter
    const text = `${item.invoiceNumber} ${item.merchant} ${item.sourceName}`.toLowerCase()
    return statusMatches && text.includes(query.trim().toLowerCase())
  }), [results, filter, query])

  const exportCsv = () => {
    const byId = new Map(results.map((item) => [item.id, item]))
    const header = ['来源文件', '页码', '区域', '发票代码', '发票号码', '商户', '开票日期', '发票金额', '核对状态', '奖项', '奖金', '重复组', '重复处理', '保留记录', '检测方式', '备注']
    const rows = allInvoices.map((invoice) => {
      const item = byId.get(invoice.id)
      const status = invoice.duplicateDecision === 'exclude' ? '重复-已排除' : item ? statusMap[item.status].label : '未参与统计'
      return [invoice.sourceName, invoice.page, (invoice.regionIndex ?? 0) + 1, invoice.invoiceCode, invoice.invoiceNumber, invoice.merchant, invoice.date, invoice.amount, status, item?.match?.prize || '', item?.match?.amount || '', invoice.duplicateGroupId || '', invoice.duplicateDecision || '', invoice.duplicateKeeperId || '', invoice.detectionMethod || '', item?.reason || '']
    })
    const csv = `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `发票中奖核对_${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="workspace result-workspace">
      <div className="page-heading result-heading">
        <div><h1>核对结果</h1><p>原始识别 {allInvoices.length} 条，去重后 {results.length} 张发票参与比对</p></div>
        <div className="heading-actions">
          <button className="button button-secondary" type="button" onClick={onRestart}><ArrowLeft size={18} />重新上传</button>
          <button className="button button-primary" type="button" onClick={exportCsv}><Download size={18} />导出结果</button>
        </div>
      </div>

      <section className="summary-band summary-band-five" aria-label="结果汇总">
        <Summary icon={FileText} label="原始识别" value={allInvoices.length} tone="blue" />
        <Summary icon={CheckCircle2} label="去重后" value={results.length} tone="green" />
        <Summary icon={Copy} label="重复排除" value={excludedInvoices.length} tone="orange" />
        <Summary icon={Trophy} label="中奖" value={won.length} tone="green" />
        <Summary icon={HelpCircle} label="待确认" value={review.length} tone="orange" />
      </section>

      {excludedInvoices.length > 0 && <section className="excluded-audit"><Copy size={17} />已排除 {excludedInvoices.length} 条重复记录；导出文件仍会保留全部来源和人工处理结果。</section>}

      <div className="results-grid">
        <section className="major-panel result-table-panel">
          <div className="panel-heading results-toolbar">
            <div><h2>核对明细</h2><p>每张发票仅按确认后的号码进行匹配</p></div>
            <label className="search-control"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索发票号码或商户" aria-label="搜索发票号码或商户" /></label>
          </div>
          <div className="status-tabs" aria-label="结果筛选">
            <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 <span>{results.length}</span></button>
            <button className={filter === 'won' ? 'active' : ''} onClick={() => setFilter('won')}>已中奖 <span>{won.length}</span></button>
            <button className={filter === 'not-won' ? 'active' : ''} onClick={() => setFilter('not-won')}>未中奖 <span>{results.length - won.length - review.length}</span></button>
            <button className={filter === 'review' ? 'active' : ''} onClick={() => setFilter('review')}>待确认 <span>{review.length}</span></button>
          </div>
          <div className="result-table">
            <div className="result-row result-head"><span>发票号码</span><span>商户</span><span>开票日期</span><span>奖项</span><span>金额</span><span>状态</span></div>
            {filteredResults.map((item) => {
              const meta = statusMap[item.status]
              const StatusIcon = meta.icon
              return (
                <div className="result-row" key={item.id}>
                  <span className="number-cell">{item.invoiceNumber || '—'}<small>{item.sourceName}</small></span>
                  <span>{item.merchant || '未识别'}</span>
                  <span>{item.date || '—'}</span>
                  <span>{item.match?.prize || '—'}</span>
                  <span>{item.match?.amount ? `¥${Number(item.match.amount).toFixed(2)}` : '—'}</span>
                  <span><span className={`status-label ${item.status}`}><StatusIcon size={15} />{meta.label}</span></span>
                </div>
              )
            })}
            {!filteredResults.length && <div className="table-empty">没有符合当前筛选条件的记录</div>}
          </div>
        </section>

        <aside className="major-panel analysis-panel">
          <div className="panel-heading"><div><h2>分析概览</h2><p>基于本次上传文件</p></div></div>
          <div className="donut-wrap">
            <div className="donut" style={{ '--won': `${wonPercent}%`, '--not-won': `${wonPercent + notWonPercent}%` }}><strong>{won.length}</strong><span>/ {results.length}</span></div>
            <div className="donut-legend">
              <span><i className="legend-won" />中奖 <strong>{won.length}</strong></span>
              <span><i className="legend-not" />未中奖 <strong>{results.length - won.length - review.length}</strong></span>
              <span><i className="legend-review" />待确认 <strong>{review.length}</strong></span>
            </div>
          </div>
          <div className="prize-total"><span>中奖金额合计</span><strong>¥{totalPrize.toFixed(2)}</strong><small>根据已识别的中奖信息实时统计</small></div>
        </aside>
      </div>

      <section className="major-panel pending-panel">
        <div className="panel-heading"><div><h2>待人工确认</h2><p>无法自动得出结论的项目不会计入中奖统计</p></div></div>
        {review.length ? review.map((item) => (
          <div className="pending-row" key={item.id}>
            <HelpCircle size={21} />
            <span className="number-cell">{item.invoiceNumber || '未识别号码'}<small>{item.sourceName}</small></span>
            <span>{item.merchant || '商户未识别'}</span>
            <span className="pending-reason">{item.reason}</span>
            {item.previewUrl ? <a className="button button-secondary compact" href={item.previewUrl} target="_blank" rel="noreferrer"><Eye size={16} />查看原图</a> : <span />}
            <div className="manual-actions">
              <button type="button" onClick={() => onUpdateStatus(item.id, 'won')}>标记中奖</button>
              <button type="button" onClick={() => onUpdateStatus(item.id, 'not-won')}>未中奖</button>
              <ChevronDown size={15} />
            </div>
          </div>
        )) : <div className="empty-success"><CheckCircle2 size={22} />没有待确认项目，所有发票均已完成核对。</div>}
      </section>
    </main>
  )
}

function Summary({ icon: Icon, label, value, tone }) {
  return <div className={`summary-item ${tone}`}><Icon size={28} /><span>{label}<strong>{value}</strong></span></div>
}
