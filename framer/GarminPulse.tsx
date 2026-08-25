import { useEffect, useLayoutEffect, useRef, useState } from "react"
import ReactDOM from "react-dom"
import { addPropertyControls, ControlType } from "framer"

/**
 * My Heart Rate — XL widget (1200 × 160 by default)
 *
 * Full-bleed chart: the widget carries no padding, the canvas fills it edge to
 * edge and the text is overlaid with a 20px inset. The area fill always closes
 * at the widget's bottom edge.
 *
 * Every plotted point comes from garmin-pulse-api. Optional bucketing averages
 * readings over N minutes (the faint band behind shows the real spread inside
 * each bucket, so smoothing never hides variance), and the curve is monotone
 * cubic so it has no corners and never overshoots into values that never
 * happened.
 *
 * The beat is one sudden event per real heartbeat — instant attack, exponential
 * decay, optional lub-dub second spike — expressed as Surge (stroke weight and
 * alpha), Flex (vertical expansion; the only style that distorts values) and
 * Bloom (fill opacity). Nothing is interpolated or predicted.
 *
 * NOTE: Framer's canvas blocks external fetch, so on canvas this falls back to
 * a baked-in sample. Real data only appears on the published site.
 */

const WIDGET_SHADOW =
    "rgba(14, 92, 126, 0.04) 0px 0px 0px 1px, rgba(42, 61, 69, 0.04) 0px 1px 1px -0.5px, rgba(42, 62, 70, 0.04) 0px 3px 3px -1.5px, rgba(42, 62, 70, 0.04) 0px 6px 6px -3px"

const TOOLTIP_SHADOW =
    "rgba(0, 0, 0, 0.12) 0px 4px 16px -2px, rgba(0, 0, 0, 0.08) 0px 1px 3px 0px"
const TIP_GAP = 4

// Real readings, thinned, so the canvas preview shows a truthful shape.
const SAMPLE_RAW =
    "0,83;26,80;42,65;58,64;74,61;90,61;106,62;122,78;138,60;154,63;170,54;186,52;202,52;218,53;234,57;250,54;266,55;282,58;298,56;314,52;330,51;346,50;362,51;378,54;394,52;410,53;426,50;442,54;458,51;474,57;490,59;506,49;522,51;538,59"

// Built at runtime so the colour stays a Framer control. Framer breaks inline
// SVG in JSX, so it has to arrive as an <img> data URI.
function heartIcon(color: string): string {
    const svg =
        '<svg width="12" height="12" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M12 21.593c-5.63-5.539-11-10.297-11-14.402 0-3.791 3.068-5.191 5.281-5.191 1.312 0 4.151.501 5.719 4.457 1.59-3.968 4.464-4.447 5.726-4.447 2.54 0 5.274 1.621 5.274 5.181 0 4.069-5.136 8.625-11 14.402z" fill="' +
        color +
        '"/></svg>'
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg)
}

type Point = { t: number; v: number; lo: number; hi: number; n: number; t0?: number; t1?: number }
type PulseData = {
    bpm: number
    restingHeartRate: number | null
    min24h: number
    max24h: number
    series: { t: number; v: number }[]
    lastSyncedAt: string | null
    isSample: boolean
}

type Mapping = {
    t0: number
    span: number
    lo: number
    hi: number
    w: number
    h: number
    padTop: number
    padBottom: number
    left: number
    right: number
}

function buildSample(): PulseData {
    const base = Date.now() - 539 * 60000
    const series = SAMPLE_RAW.split(";").map((pair) => {
        const [m, v] = pair.split(",")
        return { t: base + parseFloat(m) * 60000, v: parseInt(v, 10) }
    })
    const vals = series.map((p) => p.v)
    return {
        bpm: series[series.length - 1].v,
        restingHeartRate: 50,
        min24h: Math.min(...vals),
        max24h: Math.max(...vals),
        series,
        lastSyncedAt: null,
        isSample: true,
    }
}

function relTime(iso: string | null): string {
    if (!iso) return "sample data"
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    if (mins < 1) return "synced just now"
    if (mins < 60) return `synced ${mins} min ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `synced ${hrs} hr${hrs === 1 ? "" : "s"} ago`
    return `synced ${Math.floor(hrs / 24)}d ago`
}

function clockTime(ts: number): string {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, "0")
    const mm = String(d.getMinutes()).padStart(2, "0")
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const dayDelta = Math.round(
        (startOfToday.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000
    )
    if (dayDelta === 0) return `${hh}:${mm}`
    if (dayDelta === 1) return `Yesterday ${hh}:${mm}`
    return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })}, ${hh}:${mm}`
}

// Framer serialises colour controls as hex on canvas but "rgb(39, 132, 252)"
// when published. Parsing that as hex gives NaN -> a black fill reading as grey.
let _probeCtx: CanvasRenderingContext2D | null = null

function parseRgb(s: string): [number, number, number] | null {
    const v = s.trim()
    if (v.charAt(0) === "#") {
        let h = v.slice(1)
        if (h.length === 3) h = h.split("").map((c) => c + c).join("")
        if (h.length === 8) h = h.slice(0, 6)
        if (h.length !== 6) return null
        const n = parseInt(h, 16)
        if (isNaN(n)) return null
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    }
    const m = v.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
    if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])]
    return null
}

function toRgba(color: string, alpha: number): string {
    const fallback = `rgba(39, 132, 252, ${alpha})`
    if (typeof color !== "string" || !color) return fallback
    let rgb = parseRgb(color)
    if (!rgb && typeof document !== "undefined") {
        if (!_probeCtx) _probeCtx = document.createElement("canvas").getContext("2d")
        if (_probeCtx) {
            _probeCtx.fillStyle = "#2784fc"
            _probeCtx.fillStyle = color
            rgb = parseRgb(String(_probeCtx.fillStyle))
        }
    }
    if (!rgb) return fallback
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

// Average into fixed time buckets, keeping min/max so the spread can be drawn.
function bucket(raw: { t: number; v: number }[], minutes: number): Point[] {
    if (!minutes) {
        return raw.map((p) => ({ t: p.t, v: p.v, lo: p.v, hi: p.v, n: 1 }))
    }
    const size = minutes * 60000
    const out: any[] = []
    let cur: any = null
    raw.forEach((p) => {
        const k = Math.floor(p.t / size)
        if (!cur || cur.k !== k) {
            if (cur) out.push(cur)
            cur = { k, sum: 0, n: 0, lo: Infinity, hi: -Infinity, t0: p.t, t1: p.t }
        }
        cur.sum += p.v
        cur.n++
        cur.lo = Math.min(cur.lo, p.v)
        cur.hi = Math.max(cur.hi, p.v)
        cur.t1 = p.t
    })
    if (cur) out.push(cur)
    return out.map((b) => ({
        t: (b.t0 + b.t1) / 2,
        v: b.sum / b.n,
        lo: b.lo,
        hi: b.hi,
        n: b.n,
        t0: b.t0,
        t1: b.t1,
    }))
}

// Fritsch–Carlson monotone tangents: smooth, but never overshoots the data.
function tangents(pts: { x: number; y: number }[]): number[] {
    const n = pts.length
    const d: number[] = []
    const m: number[] = new Array(n).fill(0)
    for (let i = 0; i < n - 1; i++) {
        const dx = pts[i + 1].x - pts[i].x
        d[i] = dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx
    }
    m[0] = d[0] || 0
    m[n - 1] = d[n - 2] || 0
    for (let j = 1; j < n - 1; j++) {
        m[j] = !d[j - 1] || !d[j] || d[j - 1] * d[j] <= 0 ? 0 : (d[j - 1] + d[j]) / 2
    }
    for (let k = 0; k < n - 1; k++) {
        if (d[k] === 0) {
            m[k] = 0
            m[k + 1] = 0
            continue
        }
        const a = m[k] / d[k]
        const b = m[k + 1] / d[k]
        const s = a * a + b * b
        if (s > 9) {
            const tau = 3 / Math.sqrt(s)
            m[k] = tau * a * d[k]
            m[k + 1] = tau * b * d[k]
        }
    }
    return m
}

function curve(
    ctx: CanvasRenderingContext2D,
    pts: { x: number; y: number }[],
    closeAt: number | null
) {
    if (pts.length < 2) return
    const m = tangents(pts)
    ctx.beginPath()
    if (closeAt != null) {
        ctx.moveTo(pts[0].x, closeAt)
        ctx.lineTo(pts[0].x, pts[0].y)
    } else {
        ctx.moveTo(pts[0].x, pts[0].y)
    }
    for (let i = 0; i < pts.length - 1; i++) {
        const dx = (pts[i + 1].x - pts[i].x) / 3
        ctx.bezierCurveTo(
            pts[i].x + dx,
            pts[i].y + m[i] * dx,
            pts[i + 1].x - dx,
            pts[i + 1].y - m[i + 1] * dx,
            pts[i + 1].x,
            pts[i + 1].y
        )
    }
    if (closeAt != null) {
        ctx.lineTo(pts[pts.length - 1].x, closeAt)
        ctx.closePath()
    }
}

/**
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight fixed
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 160
 */
export default function GarminPulse(props: any) {
    const {
        width = 1200,
        height = 160,
        endpoint = "https://garmin-pulse-api-seven.vercel.app/pulse.json",
        title = "My heart rate",

        accent = "#2784FC",
        surface = "#FFFFFF",
        inkColor = "#2B2B2B",
        titleColor = "#7A7A7A",
        unitColor = "#B8B8B8",
        metaColor = "#B8B8B8",
        hairlineColor = "#EBEBEB",
        heartColor = "#BC0025",

        numeralSize = 32,
        unitSize = 10,

        titleSize = 11,
        titleWeight = 500,
        titleSpacing = 0.4,
        syncSize = 11,
        syncWeight = 500,
        syncSpacing = 0.4,

        traceTopPct = 25,
        traceBottomPct = 15,
        bucketMinutes = 5,
        lineWeight = 2,
        restingOpacity = 40,
        showResting = true,
        showEnvelope = false,
        showScrim = true,
        scrimWidth = 0,
        fillFadeTo = 25,

        revealMs = 1200,
        revealOnce = true,

        beatIntensity = 20,
        beatDecay = 9,
        beatSurge = true,
        beatFlex = false,
        beatBloom = false,
        lubDub = true,

        refreshSeconds = 300,
        showTooltip = true,
        tooltipBg = "#2B2B2B",
        tooltipTextColor = "#FFFFFF",
        tooltipSubColor = "#E0E0E0",
        tooltipFontSize = 11,
        tooltipFontWeight = 400,
        tooltipPaddingX = 9,
        tooltipPaddingY = 5,
    } = props

    const [pulse, setPulse] = useState<PulseData>(buildSample)

    const widgetRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const pulseRef = useRef<PulseData>(pulse)
    pulseRef.current = pulse

    const hoverRef = useRef<number | null>(null)
    const mapRef = useRef<Mapping | null>(null)
    const seriesRef = useRef<Point[]>([])
    const drawRef = useRef<((now: number) => void) | null>(null)
    // null = hasn't entered the viewport yet, so nothing is drawn.
    const revealStartRef = useRef<number | null>(null)

    // ---- tooltip ----
    const tipRef = useRef<HTMLDivElement>(null)
    const [tipVisible, setTipVisible] = useState(false)
    const [tip, setTip] = useState<{ title: string; sub: string } | null>(null)
    const [anchor, setAnchor] = useState({ centerX: 0, top: 0, wLeft: 0, wRight: 0 })
    const [tipLeft, setTipLeft] = useState(0)
    const [tipRadius, setTipRadius] = useState(8)

    useLayoutEffect(() => {
        if (!tipRef.current) return
        const w = tipRef.current.offsetWidth
        const padding = 20
        const minLeft = anchor.wLeft + padding
        const maxLeft = anchor.wRight - padding - w
        let l = anchor.centerX - w / 2
        l = maxLeft >= minLeft ? Math.max(minLeft, Math.min(l, maxLeft)) : minLeft
        setTipLeft(l)
        const lineHeight = tooltipFontSize * 1.4
        setTipRadius(tipRef.current.offsetHeight > lineHeight * 1.5 ? 10 : 8)
    }, [anchor, tip, tooltipFontSize, tooltipFontWeight, tooltipPaddingX, tooltipPaddingY])

    // ---- data ----
    useEffect(() => {
        let cancelled = false
        async function load() {
            try {
                const res = await fetch(endpoint, { cache: "no-store" })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const d = await res.json()
                if (cancelled || !d || !Array.isArray(d.series24h) || !d.series24h.length)
                    return
                setPulse({
                    bpm: d.bpm,
                    restingHeartRate: d.restingHeartRate,
                    min24h: d.min24h,
                    max24h: d.max24h,
                    series: d.series24h.map((p: [number, number]) => ({ t: p[0], v: p[1] })),
                    lastSyncedAt: d.lastSyncedAt,
                    isSample: false,
                })
            } catch (e) {
                // Framer canvas blocks fetch — keep the sample rather than erroring.
            }
        }
        load()
        const id = setInterval(load, Math.max(30, refreshSeconds) * 1000)
        return () => {
            cancelled = true
            clearInterval(id)
        }
    }, [endpoint, refreshSeconds])

    const [, forceTick] = useState(0)
    useEffect(() => {
        const id = setInterval(() => forceTick((n) => n + 1), 30000)
        return () => clearInterval(id)
    }, [])

    // ---- reveal on scroll into view ----
    useEffect(() => {
        const el = widgetRef.current
        if (!el || typeof window === "undefined") return
        if (typeof IntersectionObserver === "undefined") {
            revealStartRef.current = 0 // no observer: just show it
            return
        }
        const io = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        if (revealStartRef.current == null) {
                            revealStartRef.current = performance.now()
                        }
                        if (revealOnce) io.disconnect()
                    } else if (!revealOnce) {
                        revealStartRef.current = null // rewind so it replays
                    }
                })
            },
            { threshold: 0.25 }
        )
        io.observe(el)
        return () => io.disconnect()
    }, [revealOnce])

    // ---- drawing ----
    useEffect(() => {
        const cvMaybe = canvasRef.current
        if (!cvMaybe) return
        if (typeof window === "undefined") return
        const cv: HTMLCanvasElement = cvMaybe

        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        let raf = 0

        // One heartbeat: instantaneous attack, exponential decay. The optional
        // second spike ~30% later is what makes it read as lub-dub.
        function spike(p: number, at: number, amp: number, tau: number) {
            let d = p - at
            if (d < 0) d += 1
            if (d > 0.6) return 0
            return amp * Math.exp(-d / tau)
        }
        function envelope(p: number) {
            const tau = Math.max(0.01, beatDecay / 100)
            let e = spike(p, 0, 1, tau)
            if (lubDub) e = Math.max(e, spike(p, 0.3, 0.45, tau * 0.8))
            return Math.min(1.6, e * (beatIntensity / 100))
        }

        function draw(now: number) {
            const p = pulseRef.current
            const dpr = window.devicePixelRatio || 1
            const w = cv.clientWidth
            const h = cv.clientHeight
            if (!w || !h) return
            if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
                cv.width = Math.round(w * dpr)
                cv.height = Math.round(h * dpr)
            }
            const ctx = cv.getContext("2d")
            if (!ctx) return
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
            ctx.clearRect(0, 0, w, h)

            const S = bucket(p.series, Math.max(0, Math.round(bucketMinutes)))
            seriesRef.current = S
            if (S.length < 2) return

            const left = 0
            const right = w - 5
            const padTop = (h * traceTopPct) / 100
            const padBottom = (h * traceBottomPct) / 100
            const lo = p.min24h - 3
            const hi = p.max24h + 3
            const t0 = S[0].t
            const t1 = S[S.length - 1].t
            const span = Math.max(1, t1 - t0)

            // Wipe in left to right once the widget scrolls into view. Eased out so
            // it decelerates into place rather than stopping dead.
            let reveal = 1
            if (revealMs > 0 && !reduce) {
                const started = revealStartRef.current
                if (started == null) reveal = 0
                else {
                    const linear = Math.min(1, Math.max(0, (now - started) / revealMs))
                    reveal = 1 - Math.pow(1 - linear, 3)
                }
            }

            // The beat waits for the entrance to finish, so the two don't compete.
            const beatMs = 60000 / Math.max(30, p.bpm || 60)
            const E = reveal < 1 ? 0 : envelope((now % beatMs) / beatMs)

            const X = (t: number) => left + ((t - t0) / span) * (right - left)
            const Y0 = (v: number) =>
                padTop + (1 - (v - lo) / (hi - lo)) * (h - padTop - padBottom)

            // Flex expands the trace about the resting line for an instant. It is
            // the only style that moves geometry, so it briefly overstates values.
            const yRest = Y0(p.restingHeartRate || lo)
            const flexK = beatFlex ? 1 + 0.07 * E : 1
            const Y = (v: number) => yRest + (Y0(v) - yRest) * flexK

            mapRef.current = { t0, span, lo, hi, w, h, padTop, padBottom, left, right }

            const revealX = left + (right - left) * reveal
            if (reveal <= 0) return

            ctx.save()
            ctx.beginPath()
            ctx.rect(0, 0, Math.max(0, revealX + 1), h)
            ctx.clip()

            // resting reference
            if (showResting && p.restingHeartRate) {
                ctx.save()
                ctx.setLineDash([2, 4])
                ctx.strokeStyle = hairlineColor
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(left, Y(p.restingHeartRate))
                ctx.lineTo(w, Y(p.restingHeartRate))
                ctx.stroke()
                ctx.restore()
            }

            // min–max spread, so bucketing never hides real variance
            if (showEnvelope && bucketMinutes > 0) {
                const up = S.map((q) => ({ x: X(q.t), y: Y(q.hi) }))
                const dn = S.map((q) => ({ x: X(q.t), y: Y(q.lo) })).reverse()
                const mu = tangents(up)
                const md = tangents(dn)
                ctx.beginPath()
                ctx.moveTo(up[0].x, up[0].y)
                for (let i = 0; i < up.length - 1; i++) {
                    const dx = (up[i + 1].x - up[i].x) / 3
                    ctx.bezierCurveTo(
                        up[i].x + dx, up[i].y + mu[i] * dx,
                        up[i + 1].x - dx, up[i + 1].y - mu[i + 1] * dx,
                        up[i + 1].x, up[i + 1].y
                    )
                }
                ctx.lineTo(dn[0].x, dn[0].y)
                for (let j = 0; j < dn.length - 1; j++) {
                    const dx = (dn[j + 1].x - dn[j].x) / 3
                    ctx.bezierCurveTo(
                        dn[j].x + dx, dn[j].y + md[j] * dx,
                        dn[j + 1].x - dx, dn[j + 1].y - md[j + 1] * dx,
                        dn[j + 1].x, dn[j + 1].y
                    )
                }
                ctx.closePath()
                ctx.fillStyle = toRgba(accent, 0.09)
                ctx.fill()
            }

            const pts = S.map((q) => ({ x: X(q.t), y: Y(q.v) }))

            // area fill — always closes at the widget's bottom edge
            curve(ctx, pts, h)
            const fillTop = Math.min(0.5, 0.13 * (beatBloom ? 1 + 1.6 * E : 1))
            const fadeTo = Math.max(0, Math.min(1, fillFadeTo / 100))
            // The bottom stop is deliberately NOT zero: fading to fully transparent
            // makes the tint die out ~2/3 down, so the fill looks like it stops short
            // of the widget. A small residual alpha carries it to the bottom edge.
            const g = ctx.createLinearGradient(0, padTop, 0, h)
            g.addColorStop(0, toRgba(accent, fillTop))
            g.addColorStop(1, toRgba(accent, fillTop * fadeTo))
            ctx.fillStyle = g
            ctx.fill()

            // the line — Surge thickens and brightens it everywhere at once
            const dimA = restingOpacity / 100
            const alpha = beatSurge ? Math.min(1, dimA + (1 - dimA) * E) : 1
            curve(ctx, pts, null)
            ctx.strokeStyle = toRgba(accent, alpha)
            ctx.lineWidth = lineWeight * (beatSurge ? 1 + 0.8 * E : 1)
            ctx.lineJoin = "round"
            ctx.lineCap = "round"
            ctx.stroke()

            ctx.restore() // end reveal clip — scrim and marker are drawn unclipped

            // scrim keeps the overlaid text legible over the trace
            if (showScrim && scrimWidth > 0) {
                const sw = Math.min(w, scrimWidth)
                const sc = ctx.createLinearGradient(0, 0, sw, 0)
                sc.addColorStop(0, toRgba(surface, 0.92))
                sc.addColorStop(0.6, toRgba(surface, 0.6))
                sc.addColorStop(1, toRgba(surface, 0))
                ctx.fillStyle = sc
                ctx.fillRect(0, 0, sw, h)
            }

            // Marker: rides the leading edge while the line draws itself, then
            // settles on the last real reading.
            let mx2 = pts[pts.length - 1].x
            let my2 = pts[pts.length - 1].y
            if (reveal < 1) {
                for (let i = 0; i < pts.length - 1; i++) {
                    if (pts[i + 1].x >= revealX) {
                        const seg = pts[i + 1].x - pts[i].x
                        const f = seg === 0 ? 0 : (revealX - pts[i].x) / seg
                        mx2 = revealX
                        my2 = pts[i].y + (pts[i + 1].y - pts[i].y) * f
                        break
                    }
                }
            }
            ctx.beginPath()
            ctx.arc(mx2, my2, 4 + E * 6, 0, Math.PI * 2)
            ctx.fillStyle = toRgba(accent, 0.1 + E * 0.18)
            ctx.fill()
            ctx.beginPath()
            ctx.arc(mx2, my2, 3.4 + E * 0.8, 0, Math.PI * 2)
            ctx.fillStyle = accent
            ctx.fill()

            // hover crosshair
            const hv = hoverRef.current
            if (reveal >= 1 && hv != null && S[hv]) {
                const hx = X(S[hv].t)
                const hy = Y(S[hv].v)
                ctx.save()
                ctx.setLineDash([2, 3])
                ctx.strokeStyle = hairlineColor
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(hx, Math.max(0, padTop - 12))
                ctx.lineTo(hx, Math.min(h, h - padBottom + 12))
                ctx.stroke()
                ctx.restore()
                ctx.beginPath()
                ctx.arc(hx, hy, 4, 0, Math.PI * 2)
                ctx.fillStyle = surface
                ctx.fill()
                ctx.strokeStyle = accent
                ctx.lineWidth = 2
                ctx.stroke()
            }
        }

        drawRef.current = draw

        if (reduce) {
            draw(0)
            return () => {
                drawRef.current = null
            }
        }
        const frame = (now: number) => {
            draw(now)
            raf = requestAnimationFrame(frame)
        }
        raf = requestAnimationFrame(frame)
        return () => {
            cancelAnimationFrame(raf)
            drawRef.current = null
        }
    }, [
        accent, surface, hairlineColor, showResting, showEnvelope, showScrim, scrimWidth,
        bucketMinutes, lineWeight, restingOpacity, traceTopPct, traceBottomPct, fillFadeTo,
        beatIntensity, beatDecay, beatSurge, beatFlex, beatBloom, lubDub, revealMs,
        width, height,
    ])

    // ---- hover ----
    function handleMove(e: { clientX: number }) {
        if (!showTooltip) return
        const cv = canvasRef.current
        const m = mapRef.current
        const S = seriesRef.current
        if (!cv || !m || !S.length) return

        const rect = cv.getBoundingClientRect()
        const mx = (e.clientX - rect.left) * (cv.clientWidth / Math.max(1, rect.width))
        const target =
            m.t0 + ((mx - m.left) / Math.max(1, m.right - m.left)) * m.span

        let best = 0
        let bestD = Infinity
        for (let i = 0; i < S.length; i++) {
            const d = Math.abs(S[i].t - target)
            if (d < bestD) {
                bestD = d
                best = i
            }
        }
        if (hoverRef.current !== best) hoverRef.current = best

        const q = S[best]
        const px = m.left + ((q.t - m.t0) / m.span) * (m.right - m.left)
        const py =
            m.padTop + (1 - (q.v - m.lo) / (m.hi - m.lo)) * (m.h - m.padTop - m.padBottom)
        const scale = rect.width / Math.max(1, m.w)
        const wRect = widgetRef.current?.getBoundingClientRect()

        setTip({
            title: bucketMinutes ? `${Math.round(q.v)} bpm avg` : `${q.v} bpm`,
            sub:
                bucketMinutes && q.t0 != null && q.t1 != null
                    ? `${clockTime(q.t0)}–${clockTime(q.t1)} · ${q.lo}–${q.hi}`
                    : clockTime(q.t),
        })
        setAnchor({
            centerX: rect.left + px * scale,
            top: rect.top + py * scale - TIP_GAP,
            wLeft: wRect ? wRect.left : 0,
            wRight: wRect ? wRect.right : window.innerWidth,
        })
        setTipVisible(true)
    }

    function handleLeave() {
        hoverRef.current = null
        setTipVisible(false)
    }

    const labelStyle = {
        fontFamily: '"Geist", sans-serif',
        fontWeight: titleWeight,
        fontSize: titleSize,
        lineHeight: `${titleSize}px`,
        letterSpacing: `${titleSpacing}px`,
        textTransform: "uppercase" as const,
        color: titleColor,
        whiteSpace: "nowrap" as const,
    }

    // Same treatment as the title, just a lighter colour — so the two read as a
    // matched pair across the top of the widget.
    const syncStyle = {
        fontFamily: '"Geist", sans-serif',
        fontWeight: syncWeight,
        fontSize: syncSize,
        lineHeight: `${syncSize}px`,
        letterSpacing: `${syncSpacing}px`,
        textTransform: "uppercase" as const,
        color: metaColor,
        fontVariantNumeric: "tabular-nums" as const,
        whiteSpace: "nowrap" as const,
    }

    return (
        <div
            ref={widgetRef}
            style={{
                position: "relative",
                width,
                height,
                borderRadius: 16,
                padding: 0,
                backgroundColor: surface,
                boxShadow: WIDGET_SHADOW,
                overflow: "hidden",
                fontFamily: '"Geist", sans-serif',
                color: inkColor,
                boxSizing: "border-box",
            }}
        >
            <canvas
                ref={canvasRef}
                onMouseMove={handleMove}
                onMouseLeave={handleLeave}
                style={{
                    position: "absolute",
                    inset: 0,
                    width: "100%",
                    height: "100%",
                    display: "block",
                    cursor: showTooltip ? "crosshair" : "default",
                }}
            />

            <div
                style={{
                    position: "absolute",
                    inset: 0,
                    padding: 20,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-start",
                    alignItems: "flex-start",
                    gap: 12,
                    pointerEvents: "none",
                    boxSizing: "border-box",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        width: "100%",
                    }}
                >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <img
                            src={heartIcon(heartColor)}
                            width={titleSize + 1}
                            height={titleSize + 1}
                            alt=""
                            style={{ display: "block", flexShrink: 0 }}
                        />
                        <div style={labelStyle}>{title}</div>
                    </div>
                    <div style={syncStyle}>{relTime(pulse.lastSyncedAt)}</div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                        <div
                            style={{
                                fontFamily: '"Geist", sans-serif',
                                fontWeight: 500,
                                fontSize: numeralSize,
                                lineHeight: `${numeralSize}px`,
                                letterSpacing: "-0.036em",
                                color: inkColor,
                                fontVariantNumeric: "tabular-nums",
                            }}
                        >
                            {pulse.bpm}
                        </div>
                        <div
                            style={{
                                fontFamily: '"Geist", sans-serif',
                                fontWeight: 500,
                                fontSize: unitSize,
                                lineHeight: "12px",
                                letterSpacing: "0.033em",
                                textTransform: "uppercase",
                                color: unitColor,
                            }}
                        >
                            bpm
                        </div>
                    </div>
                </div>
            </div>

            {tip &&
                typeof document !== "undefined" &&
                ReactDOM.createPortal(
                    <div
                        ref={tipRef}
                        style={{
                            position: "fixed",
                            left: tipLeft,
                            top: anchor.top,
                            transform: tipVisible
                                ? "translateY(-100%)"
                                : "translateY(calc(-100% + 4px))",
                            opacity: tipVisible ? 1 : 0,
                            transition: "opacity 0.16s ease, transform 0.16s ease",
                            background: tooltipBg,
                            color: tooltipTextColor,
                            fontFamily: '"Geist", sans-serif',
                            fontSize: tooltipFontSize,
                            fontWeight: tooltipFontWeight,
                            fontVariantNumeric: "tabular-nums",
                            padding: `${tooltipPaddingY}px ${tooltipPaddingX}px`,
                            borderRadius: tipRadius,
                            boxShadow: TOOLTIP_SHADOW,
                            pointerEvents: "none",
                            zIndex: 99999,
                            whiteSpace: "nowrap",
                            width: "max-content",
                            boxSizing: "border-box",
                            lineHeight: 1.35,
                        }}
                    >
                        <div style={{ color: tooltipTextColor, fontWeight: 500 }}>{tip.title}</div>
                        <div style={{ color: tooltipSubColor }}>{tip.sub}</div>
                    </div>,
                    document.body
                )}
        </div>
    )
}

GarminPulse.displayName = "Garmin Pulse"

addPropertyControls(GarminPulse, {
    endpoint: {
        type: ControlType.String,
        title: "Endpoint",
        defaultValue: "https://garmin-pulse-api-seven.vercel.app/pulse.json",
        description: "Canvas blocks fetch — real data shows on the published site only.",
    },
    title: {
        type: ControlType.String, title: "Title", defaultValue: "My heart rate",
        description: "Small uppercase label beside the heart.",
    },

    heartColor: {
        type: ControlType.Color, title: "Heart", defaultValue: "#BC0025",
        description: "The heart icon only. Reused from the Strava widget, where it sits on a dark tooltip — hence a deeper red here.",
    },
    accent: {
        type: ControlType.Color, title: "Accent", defaultValue: "#2784FC",
        description: "Drives the line, its fill, the spread band and the end marker together.",
    },
    surface: { type: ControlType.Color, title: "Surface", defaultValue: "#FFFFFF" },
    inkColor: { type: ControlType.Color, title: "Numeral", defaultValue: "#2B2B2B" },
    titleColor: {
        type: ControlType.Color, title: "Title colour", defaultValue: "#7A7A7A",
        description: "The 'MY HEART RATE' label, top left.",
    },
    titleSize: {
        type: ControlType.Number, title: "Title size", defaultValue: 11,
        min: 8, max: 24, step: 1,
        description: "Also sets the heart icon size, so the two stay in proportion.",
    },
    titleWeight: {
        type: ControlType.Number, title: "Title weight", defaultValue: 500,
        min: 100, max: 900, step: 100,
    },
    titleSpacing: {
        type: ControlType.Number, title: "Title spacing", defaultValue: 0.4,
        min: -1, max: 4, step: 0.1,
        description: "Letter-spacing in px. Small uppercase labels want a little air.",
    },
    metaColor: {
        type: ControlType.Color, title: "Sync colour", defaultValue: "#B8B8B8",
        description: "The 'SYNCED N MIN AGO' label, top right. Lighter than the title so it reads as secondary.",
    },
    syncSize: {
        type: ControlType.Number, title: "Sync size", defaultValue: 11,
        min: 8, max: 24, step: 1,
    },
    syncWeight: {
        type: ControlType.Number, title: "Sync weight", defaultValue: 500,
        min: 100, max: 900, step: 100,
    },
    syncSpacing: {
        type: ControlType.Number, title: "Sync spacing", defaultValue: 0.4,
        min: -1, max: 4, step: 0.1,
    },
    unitColor: {
        type: ControlType.Color, title: "Unit colour", defaultValue: "#B8B8B8",
        description: "The small 'BPM' beside the big number.",
    },
    hairlineColor: {
        type: ControlType.Color, title: "Hairline", defaultValue: "#EBEBEB",
        description: "The dashed resting-rate line and the hover crosshair.",
    },

    numeralSize: {
        type: ControlType.Number, title: "Numeral size",
        defaultValue: 32, min: 16, max: 120, step: 1,
        description: "The big BPM figure. Raising it pushes the text block down, so check it against Trace top.",
    },
    unitSize: {
        type: ControlType.Number, title: "Unit size",
        defaultValue: 10, min: 8, max: 20, step: 1,
    },

    traceTopPct: {
        type: ControlType.Number, title: "Trace top",
        defaultValue: 25, min: 0, max: 80, step: 1,
        description: "Empty space above the line, as a % of widget height. Raise it to push the chart down and flatten it; lower it to give the peaks more room. Scales automatically if you change the height.",
    },
    traceBottomPct: {
        type: ControlType.Number, title: "Trace bottom",
        defaultValue: 15, min: 0, max: 60, step: 1,
        description: "Space below the line. The fill still runs past it to the bottom edge — this only sets how low the line itself can dip.",
    },
    bucketMinutes: {
        type: ControlType.Number, title: "Smoothing",
        defaultValue: 5, min: 0, max: 30, step: 1,
        description: "Minutes of readings averaged into each plotted point. 0 draws all ~440 raw readings and looks spiky. Higher is calmer but genuinely hides short spikes — turn on Spread band to keep showing them.",
    },
    lineWeight: {
        type: ControlType.Number, title: "Line weight",
        defaultValue: 2, min: 1, max: 4, step: 0.25,
        description: "Base thickness of the trace. Surge multiplies this on each beat, so a heavier line makes the beat read stronger too.",
    },
    restingOpacity: {
        type: ControlType.Number, title: "Resting opacity",
        defaultValue: 40, min: 10, max: 100, step: 5,
        description: "How dim the line sits BETWEEN beats. The distance from here up to full is the size of the flash, so raising this is the gentlest way to calm the beat without weakening it. Only matters when Surge is on.",
    },
    showResting: {
        type: ControlType.Boolean, title: "Resting line", defaultValue: true,
        description: "Dashed horizontal line at your resting heart rate, so the trace has something to be read against.",
    },
    showEnvelope: {
        type: ControlType.Boolean, title: "Spread band", defaultValue: false,
        description: "Faint band behind the line showing the real lowest and highest reading inside each averaging bucket, so smoothing never hides variance. Does nothing when Smoothing is 0.",
    },
    fillFadeTo: {
        type: ControlType.Number, title: "Fill at base",
        defaultValue: 25, min: 0, max: 100, step: 5,
        description: "% of the fill's top opacity kept at the widget's bottom edge. 0 fades out early.",
    },
    showScrim: {
        type: ControlType.Boolean, title: "Text scrim", defaultValue: true,
        description: "White fade behind the text so the line doesn't cut through the numeral. Set Scrim width to control how far it reaches.",
    },
    scrimWidth: {
        type: ControlType.Number, title: "Scrim width",
        defaultValue: 0, min: 0, max: 800, step: 10,
        description: "How far the white fade reaches from the left edge. 0 turns it off and lets the line run behind the text.",
        hidden: (p: any) => !p.showScrim,
    },

    revealMs: {
        type: ControlType.Number, title: "Reveal",
        defaultValue: 1200, min: 0, max: 4000, step: 100,
        description: "How long the line takes to draw itself in, left to right, once the widget scrolls into view. 0 skips the entrance and shows it immediately. Respects reduced-motion settings.",
    },
    revealOnce: {
        type: ControlType.Boolean, title: "Reveal once", defaultValue: true,
        description: "On: plays the first time the widget is seen and never again. Off: replays every time it scrolls back into view.",
    },

    beatSurge: {
        type: ControlType.Boolean, title: "Beat: surge", defaultValue: true,
        description: "The whole line thickens and brightens at once on each beat, then falls back to Resting opacity. Nothing moves and no reading is altered — the safest style.",
    },
    beatFlex: {
        type: ControlType.Boolean, title: "Beat: flex", defaultValue: false,
        description: "The trace stretches vertically away from the resting line for an instant, like the chart flinching. The liveliest of the three, and the ONLY one that momentarily exaggerates your actual readings.",
    },
    beatBloom: {
        type: ControlType.Boolean, title: "Beat: bloom", defaultValue: false,
        description: "The shaded area under the line swells and fades on each beat. Reads as a soft glow rather than a snap; the line itself is untouched.",
    },
    lubDub: {
        type: ControlType.Boolean, title: "Lub-dub", defaultValue: true,
        description: "Adds a smaller second beat 30% of the way to the next one — the 'dub' of a real heartbeat. It is 45% the size of the first, so it needs Beat power above roughly 50 to be noticeable at all.",
    },
    beatIntensity: {
        type: ControlType.Number, title: "Beat power",
        defaultValue: 20, min: 0, max: 200, step: 10,
        description: "Master size of EVERY beat effect. Below about 40 the three beat styles become hard to tell apart, because there is barely anything to see — if a style seems to do nothing, raise this first. 0 stops the beat entirely.",
    },
    beatDecay: {
        type: ControlType.Number, title: "Beat decay",
        defaultValue: 9, min: 2, max: 30, step: 1,
        description: "How long each beat takes to fade out. Low is a sharp snap; high lingers and starts to blur into the next beat. The attack is always instant — that is what makes it read as a heartbeat rather than a pulse of light.",
    },

    refreshSeconds: {
        type: ControlType.Number, title: "Refresh",
        defaultValue: 300, min: 30, max: 3600, step: 30,
        description: "How often the widget refetches the JSON. Polling faster will not make it fresher — your watch only reaches Garmin every 1-2 hours.",
    },
    showTooltip: {
        type: ControlType.Boolean, title: "Tooltip", defaultValue: true,
        description: "Hovering the chart snaps a crosshair to the nearest real reading and shows its time and value. Off also removes the crosshair cursor.",
    },
    tooltipBg: {
        type: ControlType.Color, title: "Tip bg", defaultValue: "#2B2B2B",
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipTextColor: {
        type: ControlType.Color, title: "Tip text", defaultValue: "#FFFFFF",
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipSubColor: {
        type: ControlType.Color, title: "Tip sub", defaultValue: "#E0E0E0",
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipFontSize: {
        type: ControlType.Number, title: "Tip size", defaultValue: 11,
        min: 8, max: 20, step: 1, hidden: (p: any) => !p.showTooltip,
    },
    tooltipFontWeight: {
        type: ControlType.Number, title: "Tip weight", defaultValue: 400,
        min: 100, max: 900, step: 100, hidden: (p: any) => !p.showTooltip,
    },
    tooltipPaddingX: {
        type: ControlType.Number, title: "Tip pad X", defaultValue: 9,
        min: 0, max: 32, step: 1, hidden: (p: any) => !p.showTooltip,
    },
    tooltipPaddingY: {
        type: ControlType.Number, title: "Tip pad Y", defaultValue: 5,
        min: 0, max: 32, step: 1, hidden: (p: any) => !p.showTooltip,
    },
})
