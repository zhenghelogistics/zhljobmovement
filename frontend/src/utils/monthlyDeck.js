// Builds the monthly BD deck as a real .pptx.
//
// PowerPoint rather than PDF on purpose: this is presented and argued over, so the BD
// team needs to be able to fix a wording or re-order a slide in the room. Charts are
// native PowerPoint chart objects, not pictures, so the underlying numbers stay
// editable too.
//
// Styling follows the ZHL brand guide: navy #003087 as the dominant colour, Horizon
// Blue #006EFF for emphasis only, generous whitespace, one idea per slide.

const NAVY   = '003087'
const BLUE   = '006EFF'
const INK    = '11203A'
const HARBOR = '5A6B80'
const SAIL   = 'F5F8FC'
const WHITE  = 'FFFFFF'
const GREEN  = '14804A'
const AMBER  = 'B45309'
const RED    = 'C0392B'

const money = (n) => 'S$' + Number(n || 0).toLocaleString('en-SG', { maximumFractionDigits: 0 })
const pctStr = (n) => `${Number(n || 0).toFixed(1)}%`

// Direction of travel against last month. Returned as text because a coloured arrow in
// a deck invites an argument about whether up is good; the number speaks for itself.
function delta(now, before) {
  if (before === null || before === undefined || before === 0) return ''
  const diff = now - before
  if (!diff) return ' (level with last month)'
  const pctChange = Math.round((diff / Math.abs(before)) * 100)
  return ` (${diff > 0 ? '+' : ''}${pctChange}% vs last month)`
}

export async function buildMonthlyDeck(report, narrative, logoDataUrl) {
  // Loaded on demand — the library is heavy and only matters when someone asks for a deck.
  const PptxGenJS = (await import('pptxgenjs')).default
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  pptx.author = 'Zhenghe Logistics'
  pptx.title = `Business Development Review — ${report.month}`

  const notes = narrative?.speakerNotes || {}

  // Every content slide shares this chrome so the deck reads as one document.
  const slide = (heading, sub) => {
    const s = pptx.addSlide()
    s.background = { color: WHITE }
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.06, fill: { color: NAVY } })
    if (heading) s.addText(heading, { x: 0.5, y: 0.32, w: 9, h: 0.5, fontSize: 26, bold: true, color: NAVY, fontFace: 'Poppins' })
    if (sub) s.addText(sub, { x: 0.5, y: 0.85, w: 9, h: 0.3, fontSize: 12, color: HARBOR, fontFace: 'Inter' })
    s.addText(report.month, { x: 8.2, y: 5.15, w: 1.6, h: 0.25, fontSize: 9, color: HARBOR, align: 'right', fontFace: 'Inter' })
    return s
  }

  // ── 1. Title ────────────────────────────────────────────────────────────────
  const title = pptx.addSlide()
  title.background = { color: NAVY }
  if (logoDataUrl) title.addImage({ data: logoDataUrl, x: 0.5, y: 0.4, w: 1.1, h: 1.4 })
  title.addText('Business Development Review', { x: 0.5, y: 2.1, w: 9, h: 0.7, fontSize: 40, bold: true, color: WHITE, fontFace: 'Poppins' })
  title.addText(report.month, { x: 0.5, y: 2.9, w: 9, h: 0.5, fontSize: 22, color: 'A9C4E8', fontFace: 'Inter' })
  title.addShape(pptx.ShapeType.rect, { x: 0.5, y: 3.6, w: 1.6, h: 0.04, fill: { color: BLUE } })
  if (narrative?.headline) {
    title.addText(narrative.headline, { x: 0.5, y: 3.9, w: 8.4, h: 0.8, fontSize: 14, color: 'D5E4F7', italic: true, fontFace: 'Inter' })
  }
  title.addNotes(notes.overview || 'Opening slide. Set the scene for the month.')

  // ── 2. The month at a glance ────────────────────────────────────────────────
  const kpi = slide('The month at a glance', 'Pipeline and delivered revenue')
  const tiles = [
    { label: 'New enquiries', value: String(report.leads.counts.received), foot: delta(report.leads.counts.received, report.previous.received).trim() },
    { label: 'Won',            value: String(report.leads.counts.won),      foot: `${pctStr(report.leads.rates.winRate)} of closed` },
    { label: 'Value won',      value: money(report.leads.value.won),        foot: delta(report.leads.value.won, report.previous.wonValue).trim() },
    { label: 'Revenue',        value: money(report.revenue.sale),           foot: `${report.revenue.jobs} jobs` },
    { label: 'Gross profit',   value: money(report.revenue.profit),         foot: `${pctStr(report.revenue.gpPercent)} margin` },
  ]
  tiles.forEach((t, i) => {
    const x = 0.5 + i * 1.84
    kpi.addShape(pptx.ShapeType.roundRect, { x, y: 1.5, w: 1.68, h: 1.5, fill: { color: SAIL }, line: { color: 'D6E0EE', width: 1 }, rectRadius: 0.08 })
    kpi.addText(t.label.toUpperCase(), { x: x + 0.12, y: 1.66, w: 1.44, h: 0.25, fontSize: 8, bold: true, color: HARBOR, charSpacing: 1, fontFace: 'Inter' })
    kpi.addText(t.value, { x: x + 0.12, y: 1.95, w: 1.44, h: 0.55, fontSize: 22, bold: true, color: NAVY, fontFace: 'Poppins' })
    if (t.foot) kpi.addText(t.foot, { x: x + 0.12, y: 2.5, w: 1.44, h: 0.4, fontSize: 8, color: HARBOR, fontFace: 'Inter' })
  })
  if (narrative?.findings?.length) {
    kpi.addText(narrative.findings.map(f => ({ text: f, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 3.2, w: 9, h: 1.7, fontSize: 11.5, color: INK, lineSpacing: 20, fontFace: 'Inter' })
  }
  kpi.addNotes(notes.overview || '')

  // ── 3. Funnel ───────────────────────────────────────────────────────────────
  const funnel = slide('Pipeline', 'Where the month’s enquiries ended up')
  const c = report.leads.counts
  const stages = [
    { k: 'Received', v: c.received, col: NAVY },
    { k: 'Quoted',   v: c.quoted,   col: '1A4FA0' },
    { k: 'Won',      v: c.won,      col: GREEN },
    { k: 'Lost',     v: c.lost,     col: RED },
    { k: 'Still open', v: c.open,   col: HARBOR },
  ]
  const widest = Math.max(...stages.map(s => s.v), 1)
  stages.forEach((st, i) => {
    const w = Math.max(0.6, (st.v / widest) * 6.2)
    const y = 1.5 + i * 0.62
    funnel.addShape(pptx.ShapeType.roundRect, { x: 2.1, y, w, h: 0.46, fill: { color: st.col }, rectRadius: 0.06 })
    funnel.addText(st.k, { x: 0.5, y, w: 1.5, h: 0.46, fontSize: 12, bold: true, color: INK, align: 'right', valign: 'middle', fontFace: 'Inter' })
    funnel.addText(String(st.v), { x: 2.1 + w + 0.12, y, w: 1, h: 0.46, fontSize: 13, bold: true, color: NAVY, valign: 'middle', fontFace: 'Poppins' })
  })
  const r = report.leads.rates, sp = report.leads.speed
  funnel.addText([
    { text: 'Quote rate ', options: { color: HARBOR } }, { text: pctStr(r.quoteRate), options: { bold: true, color: NAVY } },
    { text: '     Win rate ', options: { color: HARBOR } }, { text: pctStr(r.winRate), options: { bold: true, color: NAVY } },
    { text: '     Avg deal ', options: { color: HARBOR } }, { text: money(report.leads.value.avgWonDeal), options: { bold: true, color: NAVY } },
    { text: '     Sales cycle ', options: { color: HARBOR } },
    { text: sp.avgCycleDays != null ? `${sp.avgCycleDays} days` : 'n/a', options: { bold: true, color: NAVY } },
  ], { x: 0.5, y: 4.5, w: 9, h: 0.4, fontSize: 12, fontFace: 'Inter' })
  funnel.addNotes(notes.pipeline || '')

  // ── 4. Responsiveness ───────────────────────────────────────────────────────
  // Included because it is the number that quietly decides win rate, and it is the one
  // thing on this deck the BD team directly controls.
  const speed = slide('How quickly we responded', 'Time from enquiry arriving to someone taking ownership')
  const speedTiles = [
    { label: 'Median response', value: sp.medianResponseHours != null ? `${sp.medianResponseHours}h` : 'n/a' },
    { label: 'Average response', value: sp.avgResponseHours != null ? `${sp.avgResponseHours}h` : 'n/a' },
    { label: 'Unclaimed 14+ days', value: String(sp.unclaimed14d), warn: sp.unclaimed14d > 0 },
  ]
  speedTiles.forEach((t, i) => {
    const x = 0.5 + i * 3.1
    speed.addShape(pptx.ShapeType.roundRect, { x, y: 1.6, w: 2.85, h: 1.3, fill: { color: t.warn ? 'FDF3E7' : SAIL }, line: { color: t.warn ? AMBER : 'D6E0EE', width: 1 }, rectRadius: 0.08 })
    speed.addText(t.label.toUpperCase(), { x: x + 0.18, y: 1.78, w: 2.5, h: 0.25, fontSize: 9, bold: true, color: t.warn ? AMBER : HARBOR, charSpacing: 1, fontFace: 'Inter' })
    speed.addText(t.value, { x: x + 0.18, y: 2.08, w: 2.5, h: 0.6, fontSize: 28, bold: true, color: t.warn ? AMBER : NAVY, fontFace: 'Poppins' })
  })
  speed.addText('Median is shown alongside the average because a single enquiry left over a weekend distorts the mean.',
    { x: 0.5, y: 3.1, w: 9, h: 0.3, fontSize: 10, italic: true, color: HARBOR, fontFace: 'Inter' })
  if (narrative?.risks?.length) {
    speed.addText('Watch', { x: 0.5, y: 3.6, w: 9, h: 0.25, fontSize: 10, bold: true, color: AMBER, charSpacing: 1, fontFace: 'Inter' })
    speed.addText(narrative.risks.map(t => ({ text: t, options: { bullet: true, breakLine: true } })),
      { x: 0.5, y: 3.9, w: 9, h: 1.1, fontSize: 11, color: INK, lineSpacing: 18, fontFace: 'Inter' })
  }
  speed.addNotes(notes.pipeline || '')

  // ── 5. Where the work came from ─────────────────────────────────────────────
  const mix = slide('Where the work came from', 'Enquiry value by industry and by trade lane')
  const ind = report.leads.breakdown.byIndustry.slice(0, 6)
  if (ind.length) {
    mix.addChart(pptx.ChartType.bar, [{
      name: 'Enquiry value',
      labels: ind.map(x => x.key),
      values: ind.map(x => x.value),
    }], {
      x: 0.5, y: 1.4, w: 4.3, h: 3.4, barDir: 'bar', chartColors: [NAVY],
      showValue: false, catAxisLabelFontSize: 10, valAxisLabelFontSize: 9,
      valAxisLabelFormatCode: '#,##0', showLegend: false, title: 'By industry',
      showTitle: true, titleFontSize: 12, titleColor: HARBOR,
    })
  }
  const lanes = report.leads.breakdown.byLane.slice(0, 6)
  if (lanes.length) {
    mix.addChart(pptx.ChartType.bar, [{
      name: 'Enquiry value',
      labels: lanes.map(x => x.key),
      values: lanes.map(x => x.value),
    }], {
      x: 5.2, y: 1.4, w: 4.3, h: 3.4, barDir: 'bar', chartColors: [BLUE],
      showValue: false, catAxisLabelFontSize: 10, valAxisLabelFontSize: 9,
      valAxisLabelFormatCode: '#,##0', showLegend: false, title: 'By trade lane',
      showTitle: true, titleFontSize: 12, titleColor: HARBOR,
    })
  } else {
    mix.addText('No origin/destination recorded on this month’s enquiries.',
      { x: 5.2, y: 2.8, w: 4.3, h: 0.4, fontSize: 11, italic: true, color: HARBOR, fontFace: 'Inter' })
  }
  mix.addNotes(notes.pipeline || '')

  // ── 6. Margin by service ────────────────────────────────────────────────────
  const modes = report.revenue.byMode.filter(m => m.sale > 0).slice(0, 7)
  if (modes.length) {
    const marg = slide('Margin by service line', 'Revenue delivered and the margin it carried')
    marg.addChart(pptx.ChartType.bar, [
      { name: 'Revenue', labels: modes.map(m => m.mode), values: modes.map(m => m.sale) },
      { name: 'Profit',  labels: modes.map(m => m.mode), values: modes.map(m => m.profit) },
    ], {
      x: 0.5, y: 1.4, w: 6.2, h: 3.5, barDir: 'col', chartColors: [NAVY, BLUE],
      showLegend: true, legendPos: 'b', catAxisLabelFontSize: 9, valAxisLabelFontSize: 9,
      valAxisLabelFormatCode: '#,##0',
    })
    marg.addText('GP%', { x: 7.1, y: 1.4, w: 2.4, h: 0.3, fontSize: 10, bold: true, color: HARBOR, charSpacing: 1, fontFace: 'Inter' })
    modes.forEach((m, i) => {
      const y = 1.75 + i * 0.42
      const col = m.gpPercent >= 20 ? GREEN : m.gpPercent >= 10 ? AMBER : RED
      marg.addText(m.mode, { x: 7.1, y, w: 1.6, h: 0.35, fontSize: 10, color: INK, valign: 'middle', fontFace: 'Inter' })
      marg.addText(pctStr(m.gpPercent), { x: 8.7, y, w: 0.8, h: 0.35, fontSize: 11, bold: true, color: col, align: 'right', valign: 'middle', fontFace: 'Poppins' })
    })
    marg.addNotes(notes.overview || '')
  }

  // ── 7. Wins ─────────────────────────────────────────────────────────────────
  const wins = slide('What we won', `${report.leads.counts.won} deals, ${money(report.leads.value.won)}`)
  if (report.leads.topWins.length) {
    wins.addTable(
      [[
        { text: 'Ref', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
        { text: 'Customer', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
        { text: 'Lane', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
        { text: 'Value', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      ], ...report.leads.topWins.map(w => ([
        { text: w.ref || '' }, { text: w.customer }, { text: w.lane || '—' },
        { text: money(w.value), options: { align: 'right', bold: true } },
      ]))],
      { x: 0.5, y: 1.5, w: 9, colW: [1.5, 3.2, 2.9, 1.4], fontSize: 11, fontFace: 'Inter',
        border: { pt: 0.5, color: 'D6E0EE' }, rowH: 0.36, valign: 'middle' }
    )
  } else {
    wins.addText('No deals closed this month.', { x: 0.5, y: 2.4, w: 9, h: 0.4, fontSize: 13, italic: true, color: HARBOR, fontFace: 'Inter' })
  }
  wins.addNotes(notes.wins || '')

  // ── 8. Losses ───────────────────────────────────────────────────────────────
  // Deliberately given equal weight to the wins slide. A BD deck that only shows wins
  // gets picked apart; showing why we lost is what makes the rest of it credible.
  const loss = slide('What we lost, and why', `${report.leads.counts.lost} deals, ${money(report.leads.lostValue)}`)
  const themes = narrative?.lostThemes || []
  if (themes.length) {
    themes.slice(0, 5).forEach((t, i) => {
      const y = 1.5 + i * 0.72
      loss.addShape(pptx.ShapeType.roundRect, { x: 0.5, y, w: 0.55, h: 0.55, fill: { color: NAVY }, rectRadius: 0.06 })
      loss.addText(String(t.count ?? ''), { x: 0.5, y, w: 0.55, h: 0.55, fontSize: 15, bold: true, color: WHITE, align: 'center', valign: 'middle', fontFace: 'Poppins' })
      loss.addText(t.theme || '', { x: 1.2, y: y + 0.02, w: 8.3, h: 0.28, fontSize: 13, bold: true, color: INK, fontFace: 'Inter' })
      loss.addText(t.detail || '', { x: 1.2, y: y + 0.28, w: 8.3, h: 0.3, fontSize: 10.5, color: HARBOR, fontFace: 'Inter' })
    })
  } else if (report.leads.lostReasons.length) {
    loss.addText(report.leads.lostReasons.slice(0, 8).map(l => ({
      text: `${l.customer || l.ref}: ${l.reason}`, options: { bullet: true, breakLine: true },
    })), { x: 0.5, y: 1.5, w: 9, h: 3, fontSize: 11.5, color: INK, lineSpacing: 20, fontFace: 'Inter' })
  } else {
    loss.addText('No losses recorded with a stated reason this month.',
      { x: 0.5, y: 2.4, w: 9, h: 0.4, fontSize: 13, italic: true, color: HARBOR, fontFace: 'Inter' })
  }
  loss.addNotes(notes.losses || '')

  // ── 9. Team ─────────────────────────────────────────────────────────────────
  const team = (report.team || []).filter(t => t.handled > 0).slice(0, 8)
  if (team.length) {
    const ts = slide('By team member', 'Enquiries handled and closed')
    ts.addTable(
      [[
        { text: 'Owner', options: { bold: true, color: WHITE, fill: { color: NAVY } } },
        { text: 'Handled', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
        { text: 'Won', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
        { text: 'Value won', options: { bold: true, color: WHITE, fill: { color: NAVY }, align: 'right' } },
      ], ...team.map(t => ([
        { text: t.person.split('@')[0].replace(/\./g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()) },
        { text: String(t.handled), options: { align: 'right' } },
        { text: String(t.won), options: { align: 'right' } },
        { text: money(t.wonValue), options: { align: 'right', bold: true } },
      ]))],
      { x: 0.5, y: 1.5, w: 9, colW: [3.6, 1.8, 1.8, 1.8], fontSize: 11, fontFace: 'Inter',
        border: { pt: 0.5, color: 'D6E0EE' }, rowH: 0.36, valign: 'middle' }
    )
    ts.addNotes(notes.wins || '')
  }

  // ── 10. Actions ─────────────────────────────────────────────────────────────
  const act = slide('Before next month', 'What this points us at')
  if (narrative?.actions?.length) {
    narrative.actions.slice(0, 5).forEach((a, i) => {
      const y = 1.45 + i * 0.62
      act.addShape(pptx.ShapeType.roundRect, { x: 0.5, y, w: 0.42, h: 0.42, fill: { color: BLUE }, rectRadius: 0.05 })
      act.addText(String(i + 1), { x: 0.5, y, w: 0.42, h: 0.42, fontSize: 13, bold: true, color: WHITE, align: 'center', valign: 'middle', fontFace: 'Poppins' })
      act.addText(a, { x: 1.1, y, w: 8.4, h: 0.5, fontSize: 12.5, color: INK, valign: 'middle', fontFace: 'Inter' })
    })
  }
  const re = report.reengage || []
  if (re.length) {
    act.addText(`Dormant enquiries worth another call (${re.length})`,
      { x: 0.5, y: 4.35, w: 9, h: 0.25, fontSize: 10, bold: true, color: HARBOR, charSpacing: 1, fontFace: 'Inter' })
    act.addText(re.slice(0, 4).map(x => `${x.customer} ${money(x.value)}`).join('     '),
      { x: 0.5, y: 4.62, w: 9, h: 0.3, fontSize: 11, color: INK, fontFace: 'Inter' })
  }
  act.addNotes(notes.actions || '')

  // ── 11. Closing ─────────────────────────────────────────────────────────────
  const end = pptx.addSlide()
  end.background = { color: NAVY }
  if (logoDataUrl) end.addImage({ data: logoDataUrl, x: 4.45, y: 1.7, w: 1.1, h: 1.4 })
  end.addText('Questions', { x: 0.5, y: 3.3, w: 9, h: 0.6, fontSize: 28, bold: true, color: WHITE, align: 'center', fontFace: 'Poppins' })
  end.addText(`Figures drawn from Motus on ${new Date(report.generated_at).toLocaleDateString('en-SG')}`,
    { x: 0.5, y: 4.0, w: 9, h: 0.3, fontSize: 10, color: 'A9C4E8', align: 'center', fontFace: 'Inter' })

  await pptx.writeFile({ fileName: `ZHL_BD_Review_${report.month.replace(/\s+/g, '_')}.pptx` })
}
