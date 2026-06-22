import { useMemo, useRef, useState } from 'react'
import { FileCheck2, HelpCircle, Info, LockKeyhole, Play, RotateCcw, Settings, ShieldCheck, X } from 'lucide-react'
import UploadZone from './components/UploadZone'
import ProgressSteps from './components/ProgressSteps'
import RegionReview from './components/RegionReview'
import ReviewView from './components/ReviewView'
import ResultsView from './components/ResultsView'
import { applyDuplicateDecision, buildDuplicateGroups, recordsForStatistics } from './lib/duplicates'
import { matchInvoices, parseInvoiceDocuments, parsePrizeDocuments } from './lib/parser'

const statusText = {
  'loading tesseract core': '正在加载本地识别引擎',
  'initializing tesseract': '正在初始化识别引擎',
  'loading language traineddata': '正在加载中英文模型',
  'initializing api': '正在准备识别',
  'recognizing text': '正在识别文字',
}

export default function App() {
  const [invoiceFiles, setInvoiceFiles] = useState([])
  const [prizeFiles, setPrizeFiles] = useState([])
  const [stage, setStage] = useState('upload')
  const [processing, setProcessing] = useState(null)
  const [error, setError] = useState('')
  const [assets, setAssets] = useState([])
  const [invoices, setInvoices] = useState([])
  const [prizes, setPrizes] = useState([])
  const [duplicateGroups, setDuplicateGroups] = useState([])
  const [results, setResults] = useState([])
  const controllerRef = useRef(null)
  const ocrCacheRef = useRef(new Map())

  const currentStep = stage === 'upload' || (stage === 'processing' && processing?.phase === 'preprocess') ? 1 : stage === 'results' ? 3 : 2
  const ready = invoiceFiles.length > 0 && prizeFiles.length > 0

  const addUniqueFiles = (setter) => (incoming) => setter((existing) => {
    const seen = new Set(existing.map((file) => `${file.name}-${file.size}-${file.lastModified}`))
    return [...existing, ...incoming.filter((file) => !seen.has(`${file.name}-${file.size}-${file.lastModified}`))]
  })

  const createController = () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    return controller
  }

  const decorateDuplicates = (records) => {
    const groups = buildDuplicateGroups(records)
    const groupByMember = new Map(groups.flatMap((group) => group.memberIds.map((id) => [id, group.id])))
    return {
      groups,
      records: records.map((record) => groupByMember.has(record.id) ? {
        ...record,
        duplicateGroupId: groupByMember.get(record.id),
        duplicateDecision: 'unresolved',
        duplicateKeeperId: null,
      } : { ...record, duplicateGroupId: null, duplicateDecision: 'keep', duplicateKeeperId: null }),
    }
  }

  const startRecognition = async () => {
    if (!ready) return
    const controller = createController()
    setStage('processing')
    setError('')
    try {
      const { prepareSourceAssets } = await import('./lib/imaging')
      setProcessing({ phase: 'preprocess', group: 'invoice', progress: 0, status: '准备发票图片' })
      const preparedAssets = await prepareSourceAssets(invoiceFiles, {
        detectRegions: true,
        signal: controller.signal,
        onProgress: (progress) => setProcessing({ phase: 'preprocess', group: 'invoice', ...progress }),
      })
      setAssets(preparedAssets)
      setStage('regions')
    } catch (reason) {
      if (reason?.name !== 'AbortError') {
        console.error(reason)
        setError(reason?.message || '图片预处理失败，请检查文件后重试。')
      }
      setStage('upload')
    } finally {
      setProcessing(null)
    }
  }

  const recognizeConfirmedRegions = async () => {
    const controller = createController()
    setStage('processing')
    setError('')
    try {
      const [{ buildRegionJobs, prepareSourceAssets }, { createRecognitionProvider, recognizeWithCache }] = await Promise.all([
        import('./lib/imaging'),
        import('./lib/recognitionProvider'),
      ])
      setProcessing({ phase: 'recognize', group: 'all', progress: 0, status: '准备识别任务' })
      const prizeAssets = await prepareSourceAssets(prizeFiles, {
        detectRegions: false,
        signal: controller.signal,
        onProgress: (progress) => setProcessing({ phase: 'recognize', group: 'prize', ...progress }),
      })
      const invoiceJobs = buildRegionJobs(assets).map((job) => ({ ...job, kind: 'invoice' }))
      const prizeJobs = buildRegionJobs(prizeAssets).map((job) => ({ ...job, kind: 'prize' }))
      const provider = createRecognitionProvider('local-ocr')
      const documents = await recognizeWithCache(provider, [...invoiceJobs, ...prizeJobs], ocrCacheRef.current, {
        signal: controller.signal,
        onProgress: (progress) => setProcessing({ phase: 'recognize', group: 'all', ...progress }),
      })
      const invoiceDocs = documents.filter((document) => document.kind === 'invoice')
      const prizeDocs = documents.filter((document) => document.kind === 'prize')
      let recordOffset = 0
      const parsedInvoices = invoiceDocs.flatMap((document) => {
        const records = parseInvoiceDocuments(document, recordOffset)
        recordOffset += records.length
        return records
      })
      const duplicateState = decorateDuplicates(parsedInvoices)
      setInvoices(duplicateState.records)
      setDuplicateGroups(duplicateState.groups)
      setPrizes(parsePrizeDocuments(prizeDocs))
      setStage('review')
    } catch (reason) {
      if (reason?.name !== 'AbortError') {
        console.error(reason)
        setError(reason?.message || '识别失败，请检查文件后重试。')
      }
      setStage('regions')
    } finally {
      setProcessing(null)
    }
  }

  const updateInvoice = (id, patch) => {
    const next = invoices.map((invoice) => invoice.id === id ? { ...invoice, ...patch } : invoice)
    const duplicateState = decorateDuplicates(next)
    setInvoices(duplicateState.records)
    setDuplicateGroups(duplicateState.groups)
  }

  const resolveDuplicate = (groupId, decision, keeperId) => {
    const group = duplicateGroups.find((entry) => entry.id === groupId)
    if (!group) return
    setInvoices((records) => applyDuplicateDecision(records, group, decision, keeperId))
    setDuplicateGroups((groups) => groups.map((entry) => entry.id === groupId ? {
      ...entry,
      status: 'resolved',
      keeperId: decision === 'keeper' ? keeperId : null,
      resolution: decision,
    } : entry))
  }

  const confirmResults = () => {
    if (duplicateGroups.some((group) => group.status === 'unresolved')) return
    setResults(matchInvoices(recordsForStatistics(invoices), prizes))
    setStage('results')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const restart = () => {
    controllerRef.current?.abort()
    setInvoiceFiles([])
    setPrizeFiles([])
    setStage('upload')
    setProcessing(null)
    setAssets([])
    setInvoices([])
    setPrizes([])
    setDuplicateGroups([])
    setResults([])
    ocrCacheRef.current.clear()
    setError('')
  }

  const cancelProcessing = () => {
    controllerRef.current?.abort()
    setProcessing(null)
    setStage(assets.length ? 'regions' : 'upload')
  }

  const processingLabel = useMemo(() => {
    if (!processing) return ''
    const group = processing.group === 'invoice' ? '发票' : processing.group === 'prize' ? '中奖信息' : '全部资料'
    return `${statusText[processing.status] || processing.status || '正在处理'} · ${group}`
  }, [processing])

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" type="button" onClick={restart} aria-label="返回首页"><span className="brand-mark"><FileCheck2 size={22} /></span><strong>票鉴</strong></button>
        <div className="header-actions">
          <button type="button"><HelpCircle size={18} />使用帮助</button>
          <button type="button"><Settings size={18} />设置</button>
          <button type="button"><Info size={18} />关于</button>
        </div>
      </header>

      <ProgressSteps current={currentStep} />

      {stage === 'upload' || stage === 'processing' ? (
        <main className="workspace upload-workspace">
          <section className="upload-hero">
            <span className="hero-corner hero-corner-tl" /><span className="hero-corner hero-corner-tr" /><span className="hero-corner hero-corner-bl" /><span className="hero-corner hero-corner-br" />
            <h1>发票中奖比对</h1>
            <p>上传两类资料，自动识别并核对中奖情况</p>
          </section>
          <div className="privacy-line"><LockKeyhole size={16} />仅处理本次上传文件，不读取其他数据</div>
          {stage === 'upload' && <div className="upload-grid">
            <UploadZone kind="invoice" title="上传发票" hint="支持 JPG、PNG、PDF，可多选" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" files={invoiceFiles} onFiles={addUniqueFiles(setInvoiceFiles)} onClear={() => setInvoiceFiles([])} />
            <UploadZone kind="prize" title="上传中奖信息" hint="支持 JPG、PNG，可多选" accept="image/jpeg,image/png,image/webp" files={prizeFiles} onFiles={addUniqueFiles(setPrizeFiles)} onClear={() => setPrizeFiles([])} />
          </div>}
          {error && <div className="error-banner"><Info size={18} />{error}</div>}
          {stage === 'processing' ? (
            <section className="processing-card" aria-live="polite">
              <div className="processing-top"><span><span className="spinner" />{processingLabel}</span><strong>{Math.round((processing?.progress || 0) * 100)}%</strong></div>
              <div className="progress-bar"><span style={{ width: `${Math.round((processing?.progress || 0) * 100)}%` }} /></div>
              <div className="processing-bottom"><p>{processing?.sourceName || '首次使用需要下载 OCR 语言模型，后续会使用浏览器缓存。'}</p><button type="button" className="text-button danger-text" onClick={cancelProcessing}><X size={15} />取消</button></div>
            </section>
          ) : (
            <div className="start-area">
              <button className="button button-primary start-button" type="button" disabled={!ready} onClick={startRecognition}><Play size={19} fill="currentColor" />开始识别并比对</button>
              <p>{ready ? `已准备 ${invoiceFiles.length} 个发票文件和 ${prizeFiles.length} 张中奖图片` : '请先上传发票和中奖信息后再开始比对'}</p>
            </div>
          )}
          <section className="privacy-panel">
            <ShieldCheck size={22} />
            <div><strong>本地处理说明</strong><p>上传文件只在当前浏览器中用于 OCR 和比对。应用不会主动读取本目录或其他历史发票。</p></div>
            <button type="button" className="text-button" onClick={restart}><RotateCcw size={15} />清除本次数据</button>
          </section>
        </main>
      ) : stage === 'regions' ? (
        <RegionReview assets={assets} setAssets={setAssets} onBack={() => setStage('upload')} onConfirm={recognizeConfirmedRegions} />
      ) : stage === 'review' ? (
        <ReviewView invoices={invoices} prizes={prizes} setPrizes={setPrizes} duplicateGroups={duplicateGroups} onResolveDuplicate={resolveDuplicate} onUpdateInvoice={updateInvoice} onBack={() => setStage('regions')} onConfirm={confirmResults} />
      ) : (
        <ResultsView results={results} allInvoices={invoices} onRestart={restart} onUpdateStatus={(id, status) => setResults((items) => items.map((item) => item.id === id ? { ...item, status, reason: '' } : item))} />
      )}
    </div>
  )
}
