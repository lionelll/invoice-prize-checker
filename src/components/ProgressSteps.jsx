const steps = ['上传资料', '识别内容', '核对结果']

export default function ProgressSteps({ current }) {
  return (
    <nav className="progress-steps" aria-label="处理进度">
      {steps.map((step, index) => {
        const stepNumber = index + 1
        return (
          <div className={`progress-step ${current === stepNumber ? 'is-current' : ''} ${current > stepNumber ? 'is-done' : ''}`} key={step}>
            <span>{current > stepNumber ? '✓' : stepNumber}</span>
            <strong>{step}</strong>
            {index < steps.length - 1 && <i />}
          </div>
        )
      })}
    </nav>
  )
}
