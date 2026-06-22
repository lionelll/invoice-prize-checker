import { CheckCircle2, Copy, Image, ShieldAlert } from 'lucide-react'

export default function DuplicateReview({ groups, invoices, onResolve }) {
  if (!groups.length) {
    return <section className="major-panel duplicate-panel"><div className="empty-success"><CheckCircle2 size={21} />未发现重复或疑似重复发票。</div></section>
  }
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]))
  const unresolved = groups.filter((group) => group.status === 'unresolved').length

  return (
    <section className="major-panel duplicate-panel">
      <div className="panel-heading">
        <div><h2>重复核对</h2><p>发现 {groups.length} 组候选，其中 {unresolved} 组尚未处理</p></div>
        <span className={`duplicate-summary ${unresolved ? 'warning' : 'done'}`}>{unresolved ? <ShieldAlert size={17} /> : <CheckCircle2 size={17} />}{unresolved ? `${unresolved} 组待决定` : '已全部处理'}</span>
      </div>
      <div className="duplicate-groups">
        {groups.map((group, groupIndex) => (
          <article className={`duplicate-group ${group.status}`} key={group.id}>
            <div className="duplicate-group-heading">
              <div><Copy size={16} /><strong>重复候选组 {groupIndex + 1}</strong>{group.reasons.map((reason) => <span key={reason.type}>{reason.label}</span>)}</div>
              {group.status === 'resolved' && <strong className="resolved-text">已处理</strong>}
            </div>
            <div className="duplicate-members">
              {group.memberIds.map((memberId) => {
                const invoice = byId.get(memberId)
                if (!invoice) return null
                const kept = invoice.duplicateDecision === 'keep'
                const excluded = invoice.duplicateDecision === 'exclude'
                return (
                  <div className={`duplicate-member ${kept ? 'is-kept' : ''} ${excluded ? 'is-excluded' : ''}`} key={memberId}>
                    <div className="duplicate-preview">{invoice.previewUrl ? <img src={invoice.previewUrl} alt={invoice.sourceName} /> : <Image size={24} />}</div>
                    <div className="duplicate-member-copy"><strong>{invoice.invoiceNumber || '号码未识别'}</strong><span>{invoice.sourceName}{invoice.page > 1 ? ` · 第${invoice.page}页` : ''}</span><span>{invoice.merchant || '商户未识别'} · ¥{Number(invoice.amount || 0).toFixed(2)}</span></div>
                    <button type="button" className={`button compact ${kept ? 'button-primary' : 'button-secondary'}`} disabled={group.status === 'resolved'} onClick={() => onResolve(group.id, 'keeper', invoice.id)}>{kept ? '已保留' : '保留此条'}</button>
                    {excluded && <span className="excluded-label">已排除</span>}
                  </div>
                )
              })}
            </div>
            <div className="duplicate-group-footer"><span>若这些记录实际不是同一张发票，可全部保留。</span><button type="button" className="text-button" disabled={group.status === 'resolved'} onClick={() => onResolve(group.id, 'not_duplicate')}>不是重复，全部保留</button></div>
          </article>
        ))}
      </div>
    </section>
  )
}
