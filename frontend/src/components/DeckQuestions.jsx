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
// Always offered, even when the model had nothing specific to ask. The whole point of
// this step is that the presenter can supply what the data cannot, and that is just as
// true in a quiet period as a dramatic one.
const CATCH_ALL = {
  id: '_context',
  question: "Anything else about this period the figures don't show?",
  why: 'A customer pausing, someone on leave, a one-off job — context like this changes how the numbers should be read.',
  placeholder: 'e.g. Amandari paused pending their warehouse move, expected back in Q4',
}

export default function DeckQuestions({ questions, periodLabel, note, onSubmit, onSkip, onClose }) {
  const [answers, setAnswers] = useState({})
  const set = (id, v) => setAnswers(a => ({ ...a, [id]: v }))
  const all = [...questions, CATCH_ALL]
  const answered = all.filter(q => (answers[q.id] || '').trim()).length

  function submit() {
    onSubmit(all.map(q => ({
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
            {questions.length
              ? <>Looking at {periodLabel}, these movements stand out but can&apos;t be explained from
                  the data alone. Answering makes the commentary specific rather than generic. Skip
                  anything you&apos;d rather not comment on.</>
              : note === 'failed' || note === 'unreadable'
                ? <>The review step couldn&apos;t run this time, so there are no specific questions.
                    You can still add context below, and the deck will build either way.</>
                : <>Nothing in {periodLabel} stood out as needing explanation. Add anything the
                    figures don&apos;t show, or skip straight to building.</>}
          </p>

          {all.map((q, i) => (
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
            {answered} of {all.length} answered
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
