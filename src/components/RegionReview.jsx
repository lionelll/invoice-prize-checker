import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, Crop, FileImage, Plus, ScanLine, Trash2 } from 'lucide-react'

const PAGE_SIZE = 6

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function RegionCanvas({ asset, onChangeRegions }) {
  const interaction = useRef(null)

  const updateRegion = (regionId, patch) => {
    onChangeRegions(asset.id, asset.regions.map((region) => region.id === regionId ? { ...region, ...patch, detectionMethod: 'manual', confidence: 1 } : region))
  }

  const startInteraction = (event, region, type) => {
    event.preventDefault()
    event.stopPropagation()
    interaction.current = {
      pointerId: event.pointerId,
      type,
      regionId: region.id,
      startX: event.clientX,
      startY: event.clientY,
      original: { ...region },
    }
    event.currentTarget.closest('.region-canvas')?.setPointerCapture(event.pointerId)
  }

  const handleMove = (event) => {
    const active = interaction.current
    if (!active || active.pointerId !== event.pointerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    const deltaX = (event.clientX - active.startX) / rect.width * asset.width
    const deltaY = (event.clientY - active.startY) / rect.height * asset.height
    if (active.type === 'move') {
      updateRegion(active.regionId, {
        x: clamp(active.original.x + deltaX, 0, asset.width - active.original.width),
        y: clamp(active.original.y + deltaY, 0, asset.height - active.original.height),
      })
    } else {
      updateRegion(active.regionId, {
        width: clamp(active.original.width + deltaX, 80, asset.width - active.original.x),
        height: clamp(active.original.height + deltaY, 60, asset.height - active.original.y),
      })
    }
  }

  const finishInteraction = (event) => {
    if (interaction.current?.pointerId === event.pointerId) interaction.current = null
  }

  const addRegion = () => {
    const index = asset.regions.length
    onChangeRegions(asset.id, [...asset.regions, {
      id: `${asset.id}-manual-${Date.now()}-${index}`,
      x: asset.width * 0.15,
      y: asset.height * 0.15,
      width: asset.width * 0.7,
      height: asset.height * 0.7,
      rotation: 0,
      detectionMethod: 'manual',
      confidence: 1,
    }])
  }

  const deleteRegion = (regionId) => {
    const next = asset.regions.filter((region) => region.id !== regionId)
    onChangeRegions(asset.id, next.length ? next : [{
      id: `${asset.id}-manual-full-${Date.now()}`,
      x: 0,
      y: 0,
      width: asset.width,
      height: asset.height,
      rotation: 0,
      detectionMethod: 'manual',
      confidence: 1,
    }])
  }

  return (
    <article className="region-card">
      <div className="region-card-heading">
        <div><FileImage size={17} /><strong>{asset.sourceName}</strong>{asset.page > 1 && <span>第 {asset.page} 页</span>}</div>
        <button className="button button-secondary compact" type="button" onClick={addRegion}><Plus size={15} />添加区域</button>
      </div>
      <div
        className="region-canvas"
        onPointerMove={handleMove}
        onPointerUp={finishInteraction}
        onPointerCancel={finishInteraction}
      >
        <img src={asset.previewUrl} alt={`${asset.sourceName}区域预览`} draggable="false" />
        {asset.regions.map((region, index) => (
          <div
            className="region-box"
            key={region.id}
            style={{
              left: `${region.x / asset.width * 100}%`,
              top: `${region.y / asset.height * 100}%`,
              width: `${region.width / asset.width * 100}%`,
              height: `${region.height / asset.height * 100}%`,
            }}
            onPointerDown={(event) => startInteraction(event, region, 'move')}
          >
            <span className="region-label">发票 {index + 1}</span>
            <button type="button" className="region-delete" aria-label={`删除区域 ${index + 1}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => deleteRegion(region.id)}><Trash2 size={13} /></button>
            <span className="region-resize" aria-hidden="true" onPointerDown={(event) => startInteraction(event, region, 'resize')} />
          </div>
        ))}
      </div>
      <div className="region-card-footer">
        <span><ScanLine size={15} />检测到 {asset.regions.length} 个发票区域</span>
        <span>拖动框体调整位置，拖动右下角调整大小</span>
      </div>
    </article>
  )
}

export default function RegionReview({ assets, setAssets, onBack, onConfirm }) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(assets.length / PAGE_SIZE))
  const visibleAssets = useMemo(() => assets.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [assets, page])
  const regionCount = assets.reduce((sum, asset) => sum + asset.regions.length, 0)

  const changeRegions = (assetId, regions) => setAssets((items) => items.map((asset) => asset.id === assetId ? { ...asset, regions } : asset))

  return (
    <main className="workspace region-workspace">
      <div className="page-heading">
        <div><h1>确认发票区域</h1><p>系统已从 {assets.length} 个图片页面中检测到 {regionCount} 个区域。复杂图片可手动调整。</p></div>
      </div>
      <div className="region-help"><Crop size={19} /><div><strong>一框对应一张发票</strong><p>号码清单不需要逐条框选，保留整张图片即可在下一步提取多条号码。</p></div></div>
      <section className="region-grid">
        {visibleAssets.map((asset) => <RegionCanvas key={asset.id} asset={asset} onChangeRegions={changeRegions} />)}
      </section>
      {pageCount > 1 && (
        <div className="pagination"><button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>{page} / {pageCount}</span><button disabled={page === pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button></div>
      )}
      <div className="review-footer">
        <button className="button button-secondary" type="button" onClick={onBack}><ArrowLeft size={18} />返回上传</button>
        <div className="review-note">共 {regionCount} 个区域将进入 OCR；修改区域后只会识别最终保留的内容。</div>
        <button className="button button-primary" type="button" disabled={!regionCount} onClick={onConfirm}><Check size={18} />确认区域并识别</button>
      </div>
    </main>
  )
}
