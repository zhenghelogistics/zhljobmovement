// Job movement review deck: monthly, quarterly or yearly.
//
// PowerPoint rather than PDF because this gets presented and argued over, so it has to
// be editable in the room. Charts are native PowerPoint chart objects, not pictures, so
// the underlying numbers stay editable too.
//
// ZHL brand guide: navy dominant, Horizon Blue for emphasis only, generous whitespace,
// one idea per slide.

const NAVY = '003087', BLUE = '006EFF', INK = '11203A'
const HARBOR = '5A6B80', SAIL = 'F5F8FC', WHITE = 'FFFFFF'
const GREEN = '14804A', AMBER = 'B45309', RED = 'C0392B'

const money = (n) => 'S$' + Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 0 })
const pctStr = (n) => `${Number(n || 0).toFixed(1)}%`
const person = (e) => String(e || '').split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// Change against the equivalent previous period. Expressed in words rather than a
// coloured arrow, because whether "up" is good depends on the metric.
function delta(now, before, unit = '') {
  if (before === null || before === undefined || before === 0) return ''
  const diff = now - before
  if (!diff) return ' level with last period'
  const p = Math.round((diff / Math.abs(before)) * 100)
  return ` ${diff > 0 ? '+' : ''}${p}% vs last ${unit || 'period'}`
}

// Margin is the one figure where a colour genuinely helps a reader scan.
const gpColour = (p) => (p >= 20 ? GREEN : p >= 10 ? AMBER : RED)

export async function buildMovementDeck(report, narrative, logoDataUrl) {
  const PptxGenJS = (await import('pptxgenjs')).default
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.author = 'Zhenghe Logistics'
  pptx.title = `Operations Review — ${report.period.label}`

  const notes = narrative?.speakerNotes || {}
  const per = report.period.kind

  const slide = (heading, sub) => {
    const s = pptx.addSlide()
    s.background = { color: WHITE }
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.06, fill: { color: NAVY } })
    if (heading) s.addText(heading, { x: 0.5, y: 0.32, w: 9, h: 0.5, fontSize: 26, bold: true, color: NAVY, fontFace: 'Poppins' })
    if (sub) s.addText(sub, { x: 0.5, y: 0.85, w: 9, h: 0.3, fontSize: 12, color: HARBOR, fontFace: 'Inter' })
    s.addText(report.period.label, { x: 8.0, y: 5.15, w: 1.8, h: 0.25, fontSize: 9, color: HARBOR, align: 'right', fontFace: 'Inter' })
    return s
  }

  const tileRow = (s, tiles, y = 1.5) => {
    const w = 9 / tiles.length - 0.16
    tiles.forEach((t, i) => {
      const x = 0.5 + i * (w + 0.16)
      const warn = !!t.warn
      s.addShape(pptx.ShapeType.roundRect, {
        x, y, w, h: 1.45, rectRadius: 0.08,
        fill: { color: warn ? 'FDF3E7' : SAIL },
        line: { color: warn ? AMBER : 'D6E0EE', width: 1 },
      })
      s.addText(t.label.toUpperCase(), { x: x + 0.12, y: y + 0.14, w: w - 0.24, h: 0.25, fontSize: 8, bold: true, color: warn ? AMBER : HARBOR, charSpacing: 1, fontFace: 'Inter' })
      s.addText(t.value, { x: x + 0.12, y: y + 0.42, w: w - 0.24, h: 0.55, fontSize: 21, bold: true, color: t.colour || (warn ? AMBER : NAVY), fontFace: 'Poppins' })
      if (t.foot) s.addText(t.foot, { x: x + 0.12, y: y + 0.98, w: w - 0.24, h: 0.4, fontSize: 8, color: HARBOR, fontFace: 'Inter' })
    })
  }

  // ── 1. Title ────────────────────────────────────────────────────────────────
  const title = pptx.addSlide()
  title.background = { color: NAVY }
  if (logoDataUrl) title.addImage({ data: logoDataUrl, x: 0.5, y: 0.4, w: 1.1, h: 1.4 })
  title.addText('Operations Review', { x: 0.5, y: 2.1, w: 9, h: 0.7, fontSize: 40, bold: true, color: WHITE, fontFace: 'Poppins' })
  title.addText(report.period.label, { x: 0.5, y: 2.9, w: 9, h: 0.5, fontSize: 22, color: 'A9C4E8', fontFace: 'Inter' })
  title.addShape(pptx.ShapeType.rect, { x: 0.5, y: 3.6, w: 1.6, h: 0.04, fill: { color: BLUE } })
  if (narrative?.headline) {
    title.addText(narrative.headline, { x: 0.5, y: 3.9, w: 8.4, h: 0.8, fontSize: 14, color: 'D5E4F7', italic: true, fontFace: 'Inter' })
  }
  title.addNotes(notes.overview || 'Opening slide.')

  // ── 2. Headline figures ─────────────────────────────────────────────────────
  const v = report.volume, mny = report.money, del = report.delivery, prev = report.previous
  const kpi = slide('Performance', 'Work delivered and what it earned')
  tileRow(kpi, [
    { label: 'Jobs', value: String(v.jobs), foot: delta(v.jobs, prev.jobs, per).trim() },
    { label: 'Revenue', value: money(mny.sale), foot: delta(mny.sale, prev.sale, per).trim() },
    { label: 'Gross profit', value: money(mny.profit), foot: delta(mny.profit, prev.profit, per).trim() },
    { label: 'Margin', value: pctStr(mny.gpPercent), colour: gpColour(mny.gpPercent), foot: `was ${pctStr(prev.gpPercent)}` },
    { label: 'On time', value: del.judged ? pctStr(del.onTimeRate) : 'n/a',
      colour: del.judged && del.onTimeRate < 80 ? AMBER : undefined,
      foot: del.judged ? `${del.onTime} of ${del.judged} judged` : 'no dates recorded' },
  ])
  if (narrative?.findings?.length) {
    kpi.addText(narrative.findings.map(f => ({ text: f, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 3.2, w: 9, h: 1.7, fontSize: 11.5, color: INK, lineSpacing: 20, fontFace: 'Inter' })
  }
  kpi.addNotes(notes.overview || '')

  // ── 3. Volume moved ─────────────────────────────────────────────────────────
  const vol = slide('Volume moved', 'Physical throughput for the period')
  tileRow(vol, [
    { label: 'Jobs completed', value: String(v.completed), foot: `${v.jobs} handled in total` },
    { label: 'Weight', value: `${Math.round(v.weightKg).toLocaleString('en-SG')} kg`, foot: `${(v.weightKg / 1000).toFixed(1)} tonnes` },
    { label: 'Volume', value: `${v.cbm.toLocaleString('en-SG')} CBM` },
    { label: 'Packages', value: v.packages.toLocaleString('en-SG') },
    { label: 'Voided', value: String(v.voided), warn: v.voidRate > 10, foot: `${pctStr(v.voidRate)} of all jobs` },
  ])
  const modes = report.byMode.filter(m => m.value > 0).slice(0, 7)
  if (modes.length) {
    vol.addChart(pptx.ChartType.bar, [{ name: 'Revenue', labels: modes.map(m => m.key), values: modes.map(m => m.value) }], {
      x: 0.5, y: 3.15, w: 5.9, h: 1.85, barDir: 'bar', chartColors: [NAVY], showLegend: false,
      catAxisLabelFontSize: 9, valAxisLabelFontSize: 8, valAxisLabelFormatCode: '#,##0',
      title: 'Revenue by service line', showTitle: true, titleFontSize: 11, titleColor: HARBOR,
    })
    vol.addText('Margin', { x: 6.7, y: 3.15, w: 2.8, h: 0.25, fontSize: 9, bold: true, color: HARBOR, charSpacing: 1, fontFace: 'Inter' })
    modes.slice(0, 5).forEach((m, i) => {
      const y = 3.45 + i * 0.31
      vol.addText(m.key, { x: 6.7, y, w: 1.9, h: 0.28, fontSize: 9.5, color: INK, valign: 'middle', fontFace: 'Inter' })
      vol.addText(pctStr(m.gpPercent), { x: 8.6, y, w: 0.9, h: 0.28, fontSize: 10, bold: true, color: gpColour(m.gpPercent), align: 'right', valign: 'middle', fontFace: 'Poppins' })
    })
  }
  vol.addNotes(notes.volume || '')

  // ── 4. Trend (quarter and year only) ────────────────────────────────────────
  if (report.trend?.length > 1) {
    const tr = slide('Through the period', 'Revenue, profit and margin by month')
    tr.addChart(pptx.ChartType.bar, [
      { name: 'Revenue', labels: report.trend.map(t => t.label), values: report.trend.map(t => t.sale) },
      { name: 'Profit', labels: report.trend.map(t => t.label), values: report.trend.map(t => t.profit) },
    ], {
      x: 0.5, y: 1.4, w: 9, h: 2.7, barDir: 'col', chartColors: [NAVY, BLUE],
      showLegend: true, legendPos: 'b', catAxisLabelFontSize: 10, valAxisLabelFontSize: 9,
      valAxisLabelFormatCode: '#,##0',
    })
    const cells = report.trend.map(t => [
      { text: t.label }, { text: String(t.jobs), options: { align: 'right' } },
      { text: money(t.sale), options: { align: 'right' } },
      { text: pctStr(t.gpPercent), options: { align: 'right', bold: true, color: gpColour(t.gpPercent) } },
    ])
    tr.addTable([[
      { text: 'Month', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
      { text: 'Jobs', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'Revenue', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'GP%', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
    ], ...cells], { x: 0.5, y: 4.25, w: 9, colW: [3.0, 1.6, 2.6, 1.8], fontSize: 9.5, rowH: 0.24,
      border: { pt: 0.5, color: 'D6E0EE' }, valign: 'middle', fontFace: 'Inter' })
    tr.addNotes(notes.volume || '')
  }

  // ── 5. Delivery performance ─────────────────────────────────────────────────
  const dp = slide('Delivery performance', 'Measured against the deadline recorded on each job')
  if (del.judged) {
    tileRow(dp, [
      { label: 'On time', value: pctStr(del.onTimeRate), colour: del.onTimeRate >= 90 ? GREEN : del.onTimeRate >= 80 ? AMBER : RED,
        foot: `${del.onTime} of ${del.judged} jobs` },
      { label: 'Late', value: String(del.late), warn: del.late > 0, foot: del.late ? `${del.avgDaysLate} days late on average` : '' },
      { label: 'Avg transit', value: del.avgTransitDays != null ? `${del.avgTransitDays} days` : 'n/a', foot: 'collection to delivery' },
      { label: 'Not measurable', value: String(v.jobs - del.judged), foot: 'missing a deadline or delivery date' },
    ])
    dp.addText('Only jobs carrying both a deadline and a delivery date can be scored, so the figure above covers ' +
      `${del.judged} of ${v.jobs} jobs. Recording both on every job would make this a complete picture.`,
      { x: 0.5, y: 3.15, w: 9, h: 0.5, fontSize: 10, italic: true, color: HARBOR, fontFace: 'Inter' })
  } else {
    dp.addText('No jobs this period carried both a deadline and a delivery date, so on-time performance cannot be measured.',
      { x: 0.5, y: 1.6, w: 9, h: 0.5, fontSize: 13, italic: true, color: HARBOR, fontFace: 'Inter' })
  }
  if (narrative?.operations?.length) {
    dp.addText(narrative.operations.map(t => ({ text: t, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 3.75, w: 9, h: 1.2, fontSize: 11.5, color: INK, lineSpacing: 20, fontFace: 'Inter' })
  }
  dp.addNotes(notes.delivery || '')

  // ── 6. Customers ────────────────────────────────────────────────────────────
  const cust = slide('Customers', `Top accounts by revenue${report.risk.topCustomerName ? ` — ${report.risk.topCustomerName} is ${pctStr(report.risk.topCustomerShare)} of the period` : ''}`)
  if (report.byCustomer.length) {
    cust.addTable([[
      { text: 'Customer', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
      { text: 'Jobs', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'Revenue', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'Share', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
    ], ...report.byCustomer.map(c => ([
      { text: c.key }, { text: String(c.jobs), options: { align: 'right' } },
      { text: money(c.value), options: { align: 'right', bold: true } },
      { text: mny.sale > 0 ? pctStr((c.value / mny.sale) * 100) : '—', options: { align: 'right', color: HARBOR } },
    ]))], { x: 0.5, y: 1.45, w: 9, colW: [4.2, 1.2, 2.2, 1.4], fontSize: 11, rowH: 0.33,
      border: { pt: 0.5, color: 'D6E0EE' }, valign: 'middle', fontFace: 'Inter' })
  }
  if (report.risk.topCustomerShare >= 40) {
    cust.addText(`Concentration: ${report.risk.topCustomerName} accounts for ${pctStr(report.risk.topCustomerShare)} of revenue this period.`,
      { x: 0.5, y: 4.65, w: 9, h: 0.35, fontSize: 11, bold: true, color: AMBER, fontFace: 'Inter' })
  }
  cust.addNotes(notes.customers || '')

  // ── 7. Biggest jobs ─────────────────────────────────────────────────────────
  if (report.topJobs.length) {
    const tj = slide('Largest jobs', 'By revenue, with the margin each carried')
    tj.addTable([[
      { text: 'Job', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
      { text: 'Customer', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
      { text: 'Mode', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
      { text: 'Revenue', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'GP%', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
    ], ...report.topJobs.map(j => ([
      { text: j.job_number }, { text: j.customer }, { text: j.mode || '—' },
      { text: money(j.sale), options: { align: 'right', bold: true } },
      { text: pctStr(j.gpPercent), options: { align: 'right', bold: true, color: gpColour(j.gpPercent) } },
    ]))], { x: 0.5, y: 1.45, w: 9, colW: [1.9, 3.0, 1.9, 1.4, 0.8], fontSize: 10.5, rowH: 0.33,
      border: { pt: 0.5, color: 'D6E0EE' }, valign: 'middle', fontFace: 'Inter' })
    tj.addNotes(notes.customers || '')
  }

  // ── 8. Team ─────────────────────────────────────────────────────────────────
  const team = (report.byTeam || []).filter(t => t.jobs > 0).slice(0, 8)
  if (team.length) {
    const ts = slide('By salesperson', 'Jobs handled, revenue and the margin delivered')
    ts.addTable([[
      { text: 'Salesperson', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
      { text: 'Jobs', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'Revenue', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'Profit', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      { text: 'GP%', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
    ], ...team.map(t => ([
      { text: t.key === 'Unassigned' ? 'Unassigned' : person(t.key) },
      { text: String(t.jobs), options: { align: 'right' } },
      { text: money(t.value), options: { align: 'right' } },
      { text: money(t.profit), options: { align: 'right', bold: true } },
      { text: pctStr(t.gpPercent), options: { align: 'right', bold: true, color: gpColour(t.gpPercent) } },
    ]))], { x: 0.5, y: 1.45, w: 9, colW: [3.2, 1.2, 1.9, 1.9, 0.8], fontSize: 10.5, rowH: 0.33,
      border: { pt: 0.5, color: 'D6E0EE' }, valign: 'middle', fontFace: 'Inter' })
    ts.addNotes(notes.customers || '')
  }

  // ── 9. Watch list ───────────────────────────────────────────────────────────
  const risks = narrative?.risks || []
  if (risks.length || report.risk.missingCosting > 0) {
    const rk = slide('Watch list', 'Things worth a decision')
    let y = 1.45
    if (report.risk.missingCosting > 0) {
      rk.addShape(pptx.ShapeType.roundRect, { x: 0.5, y, w: 9, h: 0.85, fill: { color: 'FDF3E7' }, line: { color: AMBER, width: 1 }, rectRadius: 0.08 })
      rk.addText(`${report.risk.missingCosting} job${report.risk.missingCosting === 1 ? '' : 's'} carrying ${money(report.risk.missingCostingValue)} of revenue with no supplier cost recorded`,
        { x: 0.75, y: y + 0.1, w: 8.5, h: 0.32, fontSize: 12.5, bold: true, color: AMBER, fontFace: 'Inter' })
      rk.addText('Margin on this slide is overstated until those invoices are entered.',
        { x: 0.75, y: y + 0.44, w: 8.5, h: 0.3, fontSize: 10.5, color: HARBOR, fontFace: 'Inter' })
      y += 1.05
    }
    if (risks.length) {
      rk.addText(risks.map(t => ({ text: t, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y, w: 9, h: 2.2, fontSize: 12, color: INK, lineSpacing: 22, fontFace: 'Inter' })
    }
    rk.addNotes(notes.delivery || '')
  }

  // ── 10. Actions ─────────────────────────────────────────────────────────────
  const act = slide('Next period', 'What this points us at')
  if (narrative?.actions?.length) {
    narrative.actions.slice(0, 5).forEach((a, i) => {
      const y = 1.45 + i * 0.66
      act.addShape(pptx.ShapeType.roundRect, { x: 0.5, y, w: 0.42, h: 0.42, fill: { color: BLUE }, rectRadius: 0.05 })
      act.addText(String(i + 1), { x: 0.5, y, w: 0.42, h: 0.42, fontSize: 13, bold: true, color: WHITE, align: 'center', valign: 'middle', fontFace: 'Poppins' })
      act.addText(a, { x: 1.1, y, w: 8.4, h: 0.55, fontSize: 12.5, color: INK, valign: 'middle', fontFace: 'Inter' })
    })
  } else {
    act.addText('No commentary was generated for this period.', { x: 0.5, y: 2.4, w: 9, h: 0.4, fontSize: 12, italic: true, color: HARBOR, fontFace: 'Inter' })
  }
  act.addNotes(notes.actions || '')

  // ── 11. Close ───────────────────────────────────────────────────────────────
  const end = pptx.addSlide()
  end.background = { color: NAVY }
  if (logoDataUrl) end.addImage({ data: logoDataUrl, x: 4.45, y: 1.7, w: 1.1, h: 1.4 })
  end.addText('Questions', { x: 0.5, y: 3.3, w: 9, h: 0.6, fontSize: 28, bold: true, color: WHITE, align: 'center', fontFace: 'Poppins' })
  end.addText(`Figures drawn from Motus on ${new Date(report.generated_at).toLocaleDateString('en-SG')}`,
    { x: 0.5, y: 4.0, w: 9, h: 0.3, fontSize: 10, color: 'A9C4E8', align: 'center', fontFace: 'Inter' })

  await pptx.writeFile({ fileName: `ZHL_Operations_Review_${report.period.label.replace(/\s+/g, '_')}.pptx` })
}
