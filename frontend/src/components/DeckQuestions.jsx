import { useState } from 'react'
import { X, Sparkles } from 'lucide-react'

// Asks the presenter to explain what the figures cannot.
//
// The data can show that a customer stopped spending. It cannot say whether they left,
// paused, or simply had nothing to ship — which are three different stories leading to
// three different decisions. Getting that wrong in front of leadership is worse than
// staying quiet, so the model asks first and the answers go into the commentary.
//
// Every question is skippable. A deck built without answers is still a deck built from
// real figures; it just says less.
export default function DeckQuestions({ questions, periodLabel, onSubmit, onSkip, onClose }) {
  const [answers, setAnswers] = useState({})
  const set = (id, v) => setAnswers(a => ({ ...a, [id]: v }))
  const answered = questions.filter(q => (answers[q.id] || '').trim()).length

  function submit() {
    onSubmit(questions.map(q => ({
      id: q.id, question: q.question, answer: (answers[q.id] || '').trim(),
    })).filter(a => a.answer))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} color="var(--blue)" /> A few things the numbers don&apos;t explain
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="modal-body">
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
            Looking at {periodLabel}, these movements stand out but can&apos;t be explained from the
            data alone. Answering makes the commentary specific rather than generic. Skip anything
            you&apos;d rather not comment on.
          </p>

          {questions.map((q, i) => (
            <div key={q.id} style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 6 }}>
                <div style={{
                  flexShrink: 0, width: 22, height: 22, borderRadius: 6, background: 'var(--navy)',
                  color: '#fff', fontSize: 11, fontWeight: 800, display: 'flex',
                  alignItems: 'center', justifyContent: 'center', marginTop: 1,
                }}>{i + 1}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--heading)', lineHeight: 1.5 }}>
                    {q.question}
                  </div>
                  {q.why && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, fontStyle: 'italic' }}>
                      {q.why}
                    </div>
                  )}
                </div>
              </div>
              <textarea
                className="form-control"
                rows={2}
                style={{ marginLeft: 32, width: 'calc(100% - 32px)', resize: 'vertical', fontSize: 13 }}
                placeholder={q.placeholder || 'Your answer, or leave blank to skip'}
                value={answers[q.id] || ''}
                onChange={e => set(q.id, e.target.value)}
              />
            </div>
          ))}
        </div>

        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {answered} of {questions.length} answered
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={onSkip}>Skip and build</button>
            <button className="btn btn-primary btn-sm" onClick={submit}>
              Build deck{answered ? ` with ${answered} answer${answered === 1 ? '' : 's'}` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
