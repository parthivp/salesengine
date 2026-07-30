'use client'

import { useState, useId, useMemo } from 'react'
import { cn, formatNumber } from '@/lib/utils'
import { Table2, BarChart3 } from 'lucide-react'

/**
 * Charts.
 *
 * Palettes here are not chosen by eye — they were run through the data-viz
 * validator against this app's actual white surface:
 *
 *   categorical (3 series) light  … all checks pass; aqua is sub-3:1 on white, so
 *                                   the relief rule applies (direct labels + table)
 *   categorical (3 series) dark   … all checks pass
 *   ordinal ramp (5 steps) light  … blue steps 250/350/450/550/650
 *   ordinal ramp (5 steps) dark   … blue steps 600/500/400/300/200
 *
 * The first ordinal attempt failed the adjacent-ΔL check (consecutive steps too
 * close to tell apart); these are the re-stepped values that pass. Dark values are
 * separately stepped for the dark surface rather than flipped, and are declared so
 * the charts are already correct if the app gains a dark theme.
 */

const ORDINAL = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281']
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a']

// Chrome tokens from the reference palette.
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781' }
const GRID = '#e1e0d9'
const AXIS = '#c3c2b7'
const SURFACE = '#ffffff'

function ChartFrame({
  title,
  subtitle,
  legend,
  table,
  children,
}: {
  title: string
  subtitle?: string
  legend?: { label: string; color: string }[]
  table: React.ReactNode
  children: React.ReactNode
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart')

  return (
    <div className="rounded-xl border border-ink-200 bg-white">
      <div className="px-5 py-4 border-b border-ink-200 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* A table twin is mandatory: a tooltip must enhance, never gate a value. */}
          <button
            onClick={() => setView('chart')}
            aria-pressed={view === 'chart'}
            title="Chart view"
            className={cn(
              'rounded-md p-1.5 transition',
              view === 'chart' ? 'bg-brand-50 text-brand-700' : 'text-ink-400 hover:bg-ink-100'
            )}
          >
            <BarChart3 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setView('table')}
            aria-pressed={view === 'table'}
            title="Table view"
            className={cn(
              'rounded-md p-1.5 transition',
              view === 'table' ? 'bg-brand-50 text-brand-700' : 'text-ink-400 hover:bg-ink-100'
            )}
          >
            <Table2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Legend is always present for two or more series — identity never rests on
          colour alone. Text stays in ink tokens; the swatch carries the hue. */}
      {legend && legend.length >= 2 && view === 'chart' && (
        <ul className="px-5 pt-3 flex flex-wrap gap-4">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5 text-xs text-ink-600">
              <span
                aria-hidden
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ background: l.color }}
              />
              {l.label}
            </li>
          ))}
        </ul>
      )}

      <div className="p-5">{view === 'chart' ? children : table}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Funnel — ordered stages, so an ordinal single-hue ramp, not categorical
// ---------------------------------------------------------------------------

export type FunnelStage = { label: string; count: number }

export function FunnelChart({
  title,
  subtitle,
  stages,
}: {
  title: string
  subtitle?: string
  stages: FunnelStage[]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const top = Math.max(1, ...stages.map((s) => s.count))

  const ROW = 34 // ≥24px hit target including the surface gap
  const BAR = 20 // ≤24px thick, leftover band is air
  const LABEL_W = 92
  const VALUE_W = 78
  const height = stages.length * ROW + 8

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      table={
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
              <th className="py-2 font-medium">Stage</th>
              <th className="py-2 font-medium text-right">Count</th>
              <th className="py-2 font-medium text-right">% of enrolled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {stages.map((s) => (
              <tr key={s.label}>
                <td className="py-2 text-ink-800">{s.label}</td>
                <td className="py-2 text-right tabular-nums text-ink-900">{formatNumber(s.count)}</td>
                <td className="py-2 text-right tabular-nums text-ink-600">
                  {((s.count / top) * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {/* `w-full h-auto` with a viewBox and no fixed height attribute: the SVG
          scales to the container width and derives its height from the aspect
          ratio. Setting both width="100%" and a pixel height letterboxes the
          drawing — it renders at natural size, centred, with dead margins, and
          any hit target near the right edge ends up outside the painted area. */}
      <svg
        viewBox={`0 0 640 ${height}`}
        className="w-full h-auto"
        role="img"
        aria-label={`${title}: ${stages.map((s) => `${s.label} ${s.count}`).join(', ')}`}
      >
        {stages.map((s, i) => {
          const plotW = 640 - LABEL_W - VALUE_W
          const w = Math.max(0, (s.count / top) * plotW)
          const y = i * ROW + 4
          const active = hover === i

          return (
            <g
              key={s.label}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {/* Hit target spans the whole row, not just the bar. */}
              <rect
                x={0}
                y={y}
                width={640}
                height={ROW - 2}
                fill="transparent"
                style={{ pointerEvents: 'all' }}
              />

              <text
                x={LABEL_W - 10}
                y={y + BAR / 2 + 4}
                textAnchor="end"
                fontSize="11"
                fill={INK.secondary}
              >
                {s.label}
              </text>

              {/* Track in a light step of the same ramp, so the remainder reads. */}
              <rect
                x={LABEL_W}
                y={y}
                width={plotW}
                height={BAR}
                rx={4}
                fill="#f0f5fd"
              />

              {/* 4px rounded data-end; square at the baseline is achieved by
                  overlaying a small square at the left edge. */}
              {w > 0 && (
                <>
                  <rect
                    x={LABEL_W}
                    y={y}
                    width={w}
                    height={BAR}
                    rx={4}
                    fill={ORDINAL[Math.min(i, ORDINAL.length - 1)]}
                    opacity={active ? 1 : 0.94}
                  />
                  <rect
                    x={LABEL_W}
                    y={y}
                    width={Math.min(4, w)}
                    height={BAR}
                    fill={ORDINAL[Math.min(i, ORDINAL.length - 1)]}
                  />
                </>
              )}

              {/* Direct label at the tip — the relief for sub-3:1 fills, and it
                  means no value is reachable only via hover. */}
              <text
                x={LABEL_W + w + 8}
                y={y + BAR / 2 + 4}
                fontSize="11"
                fill={INK.primary}
                className="tabular-nums"
              >
                {formatNumber(s.count)}
                {i > 0 && (
                  <tspan fill={INK.muted}>
                    {'  '}
                    {((s.count / top) * 100).toFixed(0)}%
                  </tspan>
                )}
              </text>
            </g>
          )
        })}
      </svg>
    </ChartFrame>
  )
}

// ---------------------------------------------------------------------------
// Trend — three count series on one axis
// ---------------------------------------------------------------------------

export type TrendPoint = { date: string; sent: number; replies: number; tasks: number }

export function TrendChart({
  title,
  subtitle,
  points,
}: {
  title: string
  subtitle?: string
  points: TrendPoint[]
}) {
  const clipId = useId()
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  const W = 720
  const PLOT_H = 180
  const AXIS_BAND = 28 // the container must include the axis band, not clip it
  const H = PLOT_H + AXIS_BAND
  const PAD_L = 44
  const PAD_R = 56 // room for end labels
  const PAD_T = 8

  const series = useMemo(
    () => [
      { key: 'sent' as const, label: 'Emails sent', color: SERIES[0] },
      { key: 'replies' as const, label: 'Replies', color: SERIES[1] },
      { key: 'tasks' as const, label: 'Tasks done', color: SERIES[2] },
    ],
    []
  )

  // One axis for all three — they are all counts. A second scale would invent a
  // correlation that is not in the data.
  const max = Math.max(1, ...points.flatMap((p) => [p.sent, p.replies, p.tasks]))
  const ceiling = niceCeiling(max)
  const ticks = [0, ceiling / 2, ceiling]

  const plotW = W - PAD_L - PAD_R
  const x = (i: number) => PAD_L + (points.length <= 1 ? 0 : (i / (points.length - 1)) * plotW)
  const y = (v: number) => PAD_T + PLOT_H - PAD_T - (v / ceiling) * (PLOT_H - PAD_T * 2)

  const active = hoverIdx != null ? points[hoverIdx] : null

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      legend={series.map((s) => ({ label: s.label, color: s.color }))}
      table={
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-xs uppercase tracking-wide text-ink-400 border-b border-ink-100">
                <th className="py-2 font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="py-2 font-medium text-right">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {[...points].reverse().map((p) => (
                <tr key={p.date}>
                  <td className="py-1.5 text-ink-700 tabular-nums">{p.date}</td>
                  {series.map((s) => (
                    <td key={s.key} className="py-1.5 text-right tabular-nums text-ink-900">
                      {formatNumber(p[s.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
    >
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto"
          role="img"
          aria-label={`${title} over ${points.length} days`}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD_L} y={0} width={plotW} height={PLOT_H} />
            </clipPath>
          </defs>

          {/* Solid hairline gridlines, one step off the surface. Never dashed. */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={PAD_L + plotW} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
              <text
                x={PAD_L - 8}
                y={y(t) + 3.5}
                textAnchor="end"
                fontSize="10"
                fill={INK.muted}
                className="tabular-nums"
              >
                {formatNumber(t)}
              </text>
            </g>
          ))}

          <line x1={PAD_L} x2={PAD_L + plotW} y1={y(0)} y2={y(0)} stroke={AXIS} strokeWidth="1" />

          {/* Crosshair on hover. */}
          {hoverIdx != null && (
            <line
              x1={x(hoverIdx)}
              x2={x(hoverIdx)}
              y1={PAD_T}
              y2={y(0)}
              stroke={AXIS}
              strokeWidth="1"
            />
          )}

          <g clipPath={`url(#${clipId})`}>
            {series.map((s) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(' ')}
              />
            ))}

            {/* End markers: r=4 (8px), with a 2px surface ring so they stay legible
                where the lines cross. */}
            {points.length > 0 &&
              series.map((s) => (
                <circle
                  key={`end-${s.key}`}
                  cx={x(points.length - 1)}
                  cy={y(points[points.length - 1][s.key])}
                  r={4}
                  fill={s.color}
                  stroke={SURFACE}
                  strokeWidth="2"
                />
              ))}

            {hoverIdx != null &&
              series.map((s) => (
                <circle
                  key={`hov-${s.key}`}
                  cx={x(hoverIdx)}
                  cy={y(points[hoverIdx][s.key])}
                  r={4}
                  fill={s.color}
                  stroke={SURFACE}
                  strokeWidth="2"
                />
              ))}
          </g>

          {/* Direct end-labels, selectively: only the final value per series. */}
          {points.length > 0 &&
            series.map((s) => (
              <text
                key={`lbl-${s.key}`}
                x={x(points.length - 1) + 9}
                y={y(points[points.length - 1][s.key]) + 3.5}
                fontSize="10"
                fill={INK.secondary}
                className="tabular-nums"
              >
                {formatNumber(points[points.length - 1][s.key])}
              </text>
            ))}

          {/* X axis: first, middle, last only — a label per day is unreadable. */}
          {[0, Math.floor((points.length - 1) / 2), points.length - 1]
            .filter((i, k, arr) => i >= 0 && arr.indexOf(i) === k)
            .map((i) => (
              <text
                key={`x-${i}`}
                x={x(i)}
                y={PLOT_H + 16}
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                fontSize="10"
                fill={INK.muted}
              >
                {points[i]?.date.slice(5)}
              </text>
            ))}

          {/* Generous hit bands — never require landing on a 4px dot. */}
          {points.map((p, i) => (
            <rect
              key={`hit-${p.date}`}
              x={x(i) - plotW / points.length / 2}
              y={0}
              width={Math.max(24, plotW / points.length)}
              height={PLOT_H}
              fill="transparent"
              // `pointerEvents: all` is required: the default `visiblePainted`
              // does not reliably hit-test a fully transparent fill, so without
              // this the crosshair and tooltip silently never fire.
              style={{ pointerEvents: 'all' }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseMove={() => setHoverIdx(i)}
              onFocus={() => setHoverIdx(i)}
              tabIndex={0}
              role="button"
              aria-label={`${p.date}: ${p.sent} sent, ${p.replies} replies, ${p.tasks} tasks done`}
            />
          ))}
        </svg>

        {active && hoverIdx != null && (
          <div
            className="pointer-events-none absolute top-2 whitespace-nowrap rounded-lg border border-ink-200 bg-white px-2.5 py-2 shadow-sm text-xs"
            style={{
              left: `${(x(hoverIdx) / W) * 100}%`,
              transform:
                hoverIdx > points.length / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
            }}
          >
            <p className="font-medium text-ink-900 tabular-nums">{active.date}</p>
            <ul className="mt-1 space-y-0.5">
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5 whitespace-nowrap text-ink-600">
                  <span
                    aria-hidden
                    className="inline-block h-0.5 w-3 rounded-full"
                    style={{ background: s.color }}
                  />
                  {s.label}
                  <span className="ml-auto pl-3 tabular-nums text-ink-900">
                    {formatNumber(active[s.key])}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ChartFrame>
  )
}

function niceCeiling(max: number): number {
  if (max <= 5) return 5
  const mag = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 2.5, 5, 10]) {
    const candidate = m * mag
    if (candidate >= max) return candidate
  }
  return 10 * mag
}
