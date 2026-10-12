// Chronic disease tracking — what the pages show of the measures: per chart the SVG, the latest value, the change from
// the reading before, the target in words, and the out-of-range flag (the patient's Tracking tab and the patient portal).
const { formatNumber, formatDate } = require('../../core/format');
const chart = require('./chart');

function targetText(t, digits, locale) {
  if (!t) return '';
  const n = (v) => formatNumber(v, locale, digits);
  if (t.lo !== null && t.hi !== null) return `${n(t.lo)}–${n(t.hi)}`;
  if (t.hi !== null) return t.strict ? `< ${n(t.hi)}` : `≤ ${n(t.hi)}`;
  return t.lo !== null ? `≥ ${n(t.lo)}` : '';
}

/** @param m measures(...).list  @param t translator  @param locale 'ar' | 'en' */
function charts(m, t, locale) {
  const dateFmt = (on) => formatDate(on, locale, { day: 'numeric', month: 'short', year: '2-digit' });
  return m.list.map((x) => {
    const n = (v) => formatNumber(v, locale, x.digits);
    const sLabel = (s) => (x.series.length > 1 ? t(`chronic.series.${s.key}`) : '');
    const isBp = x.key === 'bp';
    const sys = x.series.find((s) => s.key === 'sys'); const dia = x.series.find((s) => s.key === 'dia');
    let latest; let change = null; let target; let latestLabel = '';
    if (isBp && sys) {
      latest = `${n(sys.last.v)}${dia ? `/${n(dia.last.v)}` : ''}`;
      if (sys.change !== null) change = { text: `${sys.change > 0 ? '+' : ''}${n(sys.change)}${dia && dia.change !== null ? `/${dia.change > 0 ? '+' : ''}${n(dia.change)}` : ''}`, dir: Math.sign(sys.change) };
      target = sys.target ? `< ${n(sys.target.hi)}/${n(dia ? dia.target.hi : 0)}` : '';
    } else {
      const lastS = x.series.slice().sort((a, b) => `${b.last.on} ${b.last.time || ''}`.localeCompare(`${a.last.on} ${a.last.time || ''}`))[0];
      latest = `${n(lastS.last.v)}`;
      if (lastS.change !== null) change = { text: `${lastS.change > 0 ? '+' : ''}${n(lastS.change)}`, dir: Math.sign(lastS.change) };
      target = x.series.map((s) => { const tt = targetText(s.target, x.digits, locale); return tt ? `${sLabel(s) ? `${sLabel(s)} ` : ''}${tt}` : ''; }).filter(Boolean).join(' · ');
      latestLabel = sLabel(lastS);
    }
    const lastOut = x.series.some((s) => s.last && s.last.out && s.last.on === x.lastOn);
    const outCount = x.series.reduce((a, s) => a + s.points.filter((p) => p.out).length, 0);
    const svg = chart.render({
      title: t(`chronic.measures.${x.key}`),
      series: x.series.map((s) => ({ ...s, label: sLabel(s) })),
      fmt: n, dateFmt, outLabel: t('chronic.out_of_range'),
      tip: (p) => `${n(p.v)} ${x.unit}${p.source === 'visit' ? ` · ${t('chronic.from_visit')}` : ''}`,
    });
    return { key: x.key, unit: x.unit, latest, latestLabel, lastOn: x.lastOn, change, target, lastOut, outCount, svg, series: x.series.map((s) => ({ key: s.key, cls: s.cls, label: sLabel(s) })) };
  });
}

/** A reading's value as text: "120/80", "6.8". */
const valueText = (r, locale) => (r.kind === 'bp' && r.value2 !== null && r.value2 !== undefined
  ? `${formatNumber(r.value, locale, 0)}/${formatNumber(r.value2, locale, 0)}` : formatNumber(r.value, locale, 2));

module.exports = { charts, targetText, valueText };
