import { useRef, useState } from 'react'
import { FileImage, FileText, FolderOpen, Trash2, UploadCloud } from 'lucide-react'

export default function UploadZone({ kind, title, hint, accept, files, onFiles, onClear }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const isInvoice = kind === 'invoice'
  const Icon = isInvoice ? FileText : FileImage

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || [])
    if (incoming.length) onFiles(incoming)
  }

  return (
    <section
      className={`upload-zone ${dragging ? 'is-dragging' : ''} ${files.length ? 'has-files' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        addFiles(event.dataTransfer.files)
      }}
    >
      <span className="scan-corner corner-tl" />
      <span className="scan-corner corner-tr" />
      <div className="upload-illustration" aria-hidden="true">
        <span className="paper paper-back" />
        <span className="paper paper-front"><Icon size={28} /></span>
      </div>
      <h2>{title}</h2>
      <p>{hint}</p>
      <button className="button button-primary upload-button" type="button" onClick={() => inputRef.current?.click()}>
        <FolderOpen size={18} />
        {isInvoice ? '选择发票文件' : '选择中奖图片'}
      </button>
      <p className="drop-hint"><UploadCloud size={16} />或将文件拖拽到此区域</p>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept={accept}
        multiple
        onChange={(event) => {
          addFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <div className="file-strip">
        <span><FileText size={17} /> 已选择 <strong>{files.length}</strong> 个文件</span>
        {files.length > 0 && (
          <button type="button" className="text-button" onClick={onClear}><Trash2 size={15} />清空</button>
        )}
      </div>
      {files.length > 0 && (
        <div className="file-list" aria-label={`${title}文件列表`}>
          {files.slice(0, 3).map((file, index) => <span key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>{file.name}</span>)}
          {files.length > 3 && <span>还有 {files.length - 3} 个文件</span>}
        </div>
      )}
    </section>
  )
}
