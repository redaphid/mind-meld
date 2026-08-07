// The embedding pipeline over time.
//
// Drawn as SVG rather than with a chart library: there is no build step here,
// everything is vendored, and this needs three series and a tooltip — well
// under the point where a library earns its download.
//
// The three flows are plotted on TWO scales on purpose. `arrived` and
// `embedded` are messages and share an axis, so "is it keeping up" is the
// visual question of whether the bars cover the line. `summarized` is sessions,
// an order of magnitude smaller — on the same axis it is a flat zero even when
// the GPU is saturated, which is precisely the misreading that made the
// dashboard call a busy machine stalled. It gets its own strip and its own
// peak.

import { html } from 'preact'
import { fmtNum, fmtExact } from './util.js'

const PAD_TOP = 6
const PLOT_H = 90
const STRIP_H = 18
const STRIP_GAP = 6
const TOTAL_H = PAD_TOP + PLOT_H + STRIP_GAP + STRIP_H

const clockLabel = iso =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// A bucket's tooltip has to say what the bucket covers, not just its values —
// "12" means nothing without knowing whether it spans a minute or an hour.
const bucketTitle = (b, bucketMinutes) =>
  `${clockLabel(b.at)} · ${bucketMinutes}m bucket\n` +
  `${fmtExact(b.embedded)} embedded\n` +
  `${fmtExact(b.arrived)} arrived\n` +
  `${fmtExact(b.summarized)} summarized`

export const EmbeddingChart = ({ series }) => {
  const buckets = series?.buckets ?? []
  if (buckets.length === 0)
    return html`<div class="faint" style="padding:18px 0;font-size:13px">no activity in this window</div>`

  // Scales are independent, and each is floored at 1 so an all-zero window
  // draws an empty chart instead of dividing by zero.
  const msgPeak = Math.max(1, series.peak.embedded, series.peak.arrived)
  const sumPeak = Math.max(1, series.peak.summarized)

  const n = buckets.length
  const bw = 100 / n // percent width per bucket, so the SVG scales with the card
  const y = v => PAD_TOP + PLOT_H - (v / msgPeak) * PLOT_H

  // `arrived` is drawn as a line over the bars rather than as a second set of
  // bars: two interleaved bar series at 60 buckets is unreadable on a phone.
  const arrivedPath = buckets
    .map((b, i) => `${i === 0 ? 'M' : 'L'} ${(i + 0.5) * bw} ${y(b.arrived)}`)
    .join(' ')

  return html`
    <div class="chart-wrap">
      <svg
        class="chart"
        viewBox=${`0 0 100 ${TOTAL_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label=${`Embedding activity over the last ${series.windowMinutes} minutes`}
      >
        <!-- embedded: the work actually completed -->
        ${buckets.map((b, i) => {
          const h = b.embedded === 0 ? 0 : Math.max(1, (b.embedded / msgPeak) * PLOT_H)
          return html`<rect
            x=${i * bw + bw * 0.12}
            y=${PAD_TOP + PLOT_H - h}
            width=${bw * 0.76}
            height=${h}
            class="ch-embedded"
          />`
        })}

        <!-- arrived: what showed up to be worked -->
        <path d=${arrivedPath} class="ch-arrived" vector-effect="non-scaling-stroke" />

        <!-- summarized: own scale, own strip -->
        ${buckets.map((b, i) => {
          const h = b.summarized === 0 ? 0 : Math.max(2, (b.summarized / sumPeak) * STRIP_H)
          return html`<rect
            x=${i * bw + bw * 0.12}
            y=${PAD_TOP + PLOT_H + STRIP_GAP + (STRIP_H - h)}
            width=${bw * 0.76}
            height=${h}
            class="ch-summarized"
          />`
        })}

        <!-- Transparent hit targets on top, one per bucket, so a tap anywhere
             in the column gets that bucket's tooltip. -->
        ${buckets.map(
          (b, i) => html`<rect x=${i * bw} y="0" width=${bw} height=${TOTAL_H} class="ch-hit">
            <title>${bucketTitle(b, series.bucketMinutes)}</title>
          </rect>`
        )}
      </svg>

      <div class="chart-axis">
        <span>${clockLabel(buckets[0].at)}</span>
        <span class="right">${clockLabel(buckets[buckets.length - 1].at)}</span>
      </div>

      <div class="chart-legend">
        <span><i class="sw-embedded"></i>embedded ${fmtNum(series.totals.embedded)}</span>
        <span><i class="sw-arrived"></i>arrived ${fmtNum(series.totals.arrived)}</span>
        <span><i class="sw-summarized"></i>summarized ${fmtNum(series.totals.summarized)}</span>
        <span class="right faint">peak ${fmtNum(msgPeak)}/${series.bucketMinutes}m</span>
      </div>
    </div>
  `
}

// Windows worth offering: the last hour answers "what is it doing now", the day
// answers "did it run overnight", and six hours is the one that shows a drain
// starting and finishing in the same picture.
export const CHART_WINDOWS = [
  { minutes: 60, label: '1h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
]

export const ChartWindowPicker = ({ value, onChange }) => html`
  <span class="seg">
    ${CHART_WINDOWS.map(
      w => html`<button
        class=${w.minutes === value ? 'active' : ''}
        onClick=${() => onChange(w.minutes)}
      >
        ${w.label}
      </button>`
    )}
  </span>
`
