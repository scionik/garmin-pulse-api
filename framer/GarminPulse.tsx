import { useEffect, useLayoutEffect, useRef, useState } from "react"
import ReactDOM from "react-dom"
import { addPropertyControls, ControlType } from "framer"

/**
 * Garmin Pulse — XL widget (1200 × 288)
 *
 * Draws the real 24h heart-rate series from garmin-pulse-api. Every point on the
 * line is a reading the watch actually took; the only animated element is the
 * marker at the live end, which beats at the real current BPM.
 *
 * Hovering the trace snaps a crosshair to the nearest real reading and shows its
 * time and value. The tooltip is portalled to document.body because the widget
 * clips its own overflow.
 *
 * NOTE: Framer's canvas blocks external fetch, so on canvas this falls back to a
 * baked-in sample and says so. Real data only appears on the published site.
 */

const WIDGET_SHADOW =
    "rgba(14, 92, 126, 0.04) 0px 0px 0px 1px, rgba(42, 61, 69, 0.04) 0px 1px 1px -0.5px, rgba(42, 62, 70, 0.04) 0px 3px 3px -1.5px, rgba(42, 62, 70, 0.04) 0px 6px 6px -3px"

const TOOLTIP_SHADOW =
    "rgba(0, 0, 0, 0.12) 0px 4px 16px -2px, rgba(0, 0, 0, 0.08) 0px 1px 3px 0px"
const TIP_GAP = 4

// Real readings, thinned, so the canvas preview shows a truthful shape.
const SAMPLE_RAW =
    "0,83;26,80;42,65;58,64;74,61;90,61;106,62;122,78;138,60;154,63;170,54;186,52;202,52;218,53;234,57;250,54;266,55;282,58;298,56;314,52;330,51;346,50;362,51;378,54;394,52;410,53;426,50;442,54;458,51;474,57;490,59;506,49;522,51;538,59"

type Point = { t: number; v: number }
type PulseData = {
    bpm: number
    restingHeartRate: number | null
    min24h: number
    max24h: number
    series: Point[]
    lastSyncedAt: string | null
    isSample: boolean
}

// Geometry shared between the renderer and the hover hit-test, so the crosshair
// lands exactly on the drawn line rather than on a re-derived approximation.
type Mapping = {
    t0: number
    span: number
    lo: number
    hi: number
    w: number
    h: number
    padTop: number
    padBottom: number
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
    const dayDelta = Math.round((startOfToday.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86400000)
    if (dayDelta === 0) return `${hh}:${mm}`
    if (dayDelta === 1) return `Yesterday ${hh}:${mm}`
    return `${d.getDate()} ${d.toLocaleString("en", { month: "short" })}, ${hh}:${mm}`
}

function hexToRgba(hex: string, alpha: number): string {
    let h = hex.replace("#", "")
    if (h.length === 3) h = h.split("").map((c) => c + c).join("")
    const n = parseInt(h, 16)
    const r = (n >> 16) & 255
    const g = (n >> 8) & 255
    const b = n & 255
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * @framerSupportedLayoutWidth fixed
 * @framerSupportedLayoutHeight fixed
 * @framerIntrinsicWidth 1200
 * @framerIntrinsicHeight 288
 */
export default function GarminPulse(props: any) {
    const {
        width = 1200,
        height = 288,
        endpoint = "https://garmin-pulse-api-seven.vercel.app/pulse.json",
        accent = "#2784FC",
        surface = "#FFFFFF",
        inkColor = "#2B2B2B",
        mutedColor = "#7A7A7A",
        hairlineColor = "#EBEBEB",
        showResting = true,
        numeralSize = 84,
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
    const numeralRef = useRef<HTMLDivElement>(null)
    const pulseRef = useRef<PulseData>(pulse)
    pulseRef.current = pulse

    // Hover index lives in a ref so the animation loop can read it without the
    // effect re-running (and restarting the rAF) on every mouse move.
    const hoverRef = useRef<number | null>(null)
    const mapRef = useRef<Mapping | null>(null)
    const drawRef = useRef<((phase: number) => void) | null>(null)

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
                // Framer canvas blocks fetch — keep the sample rather than showing an error.
            }
        }

        load()
        const id = setInterval(load, Math.max(30, refreshSeconds) * 1000)
        return () => {
            cancelled = true
            clearInterval(id)
        }
    }, [endpoint, refreshSeconds])

    // ---- "synced X ago" ticks without refetching ----
    const [, forceTick] = useState(0)
    useEffect(() => {
        const id = setInterval(() => forceTick((n) => n + 1), 30000)
        return () => clearInterval(id)
    }, [])

    // ---- drawing ----
    useEffect(() => {
        // Re-bound through an explicitly non-nullable const: TypeScript won't carry
        // a narrowed type into the nested draw() closure, but a declared type holds.
        const cvMaybe = canvasRef.current
        if (!cvMaybe) return
        if (typeof window === "undefined") return
        const cv: HTMLCanvasElement = cvMaybe

        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        let raf = 0

        function draw(phase: number) {
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

            const padTop = 26
            const padBottom = 26
            const lo = p.min24h - 3
            const hi = p.max24h + 3
            const t0 = p.series[0].t
            const t1 = p.series[p.series.length - 1].t
            const span = Math.max(1, t1 - t0)

            mapRef.current = { t0, span, lo, hi, w, h, padTop, padBottom }

            const X = (t: number) => ((t - t0) / span) * (w - 10)
            const Y = (v: number) =>
                padTop + (1 - (v - lo) / (hi - lo)) * (h - padTop - padBottom)

            // resting reference
            if (showResting && p.restingHeartRate) {
                const yRest = Y(p.restingHeartRate)
                ctx.save()
                ctx.setLineDash([2, 4])
                ctx.strokeStyle = hairlineColor
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(0, yRest)
                ctx.lineTo(w, yRest)
                ctx.stroke()
                ctx.restore()
                ctx.fillStyle = mutedColor
                ctx.font = '500 10px "Geist", sans-serif'
                ctx.fillText(`resting ${p.restingHeartRate}`, 2, yRest - 6)
            }

            // area under the line
            ctx.beginPath()
            ctx.moveTo(X(t0), h)
            p.series.forEach((pt) => ctx.lineTo(X(pt.t), Y(pt.v)))
            ctx.lineTo(X(t1), h)
            ctx.closePath()
            const grad = ctx.createLinearGradient(0, padTop, 0, h)
            grad.addColorStop(0, hexToRgba(accent, 0.14))
            grad.addColorStop(1, hexToRgba(accent, 0))
            ctx.fillStyle = grad
            ctx.fill()

            // the line
            ctx.beginPath()
            p.series.forEach((pt, i) => {
                const x = X(pt.t)
                const y = Y(pt.v)
                if (i === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
            })
            ctx.strokeStyle = accent
            ctx.lineWidth = 1.6
            ctx.lineJoin = "round"
            ctx.lineCap = "round"
            ctx.stroke()

            // live endpoint
            const last = p.series[p.series.length - 1]
            const ex = X(last.t)
            const ey = Y(last.v)
            if (phase < 0.55) {
                const ring = phase / 0.55
                ctx.beginPath()
                ctx.arc(ex, ey, 3 + ring * 13, 0, Math.PI * 2)
                ctx.strokeStyle = hexToRgba(accent, 0.4 * (1 - ring))
                ctx.lineWidth = 1.5
                ctx.stroke()
            }
            const pop = phase < 0.16 ? 1 + (1 - phase / 0.16) * 0.45 : 1
            ctx.beginPath()
            ctx.arc(ex, ey, 3.2 * pop, 0, Math.PI * 2)
            ctx.fillStyle = accent
            ctx.fill()

            // hover crosshair, snapped to the nearest real reading
            const hi_ = hoverRef.current
            if (hi_ != null && p.series[hi_]) {
                const pt = p.series[hi_]
                const hx = X(pt.t)
                const hy = Y(pt.v)
                ctx.save()
                ctx.setLineDash([2, 3])
                ctx.strokeStyle = hairlineColor
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(hx, padTop - 10)
                ctx.lineTo(hx, h - padBottom + 10)
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
            draw(1)
            return () => {
                drawRef.current = null
            }
        }

        const frame = (now: number) => {
            const beatMs = 60000 / Math.max(30, pulseRef.current.bpm || 60)
            const phase = (((now / beatMs) % 1) + 1) % 1
            draw(phase)
            if (numeralRef.current) {
                const s = phase < 0.14 ? 1 + (1 - phase / 0.14) * 0.022 : 1
                numeralRef.current.style.transform = `scale(${s.toFixed(4)})`
            }
            raf = requestAnimationFrame(frame)
        }
        raf = requestAnimationFrame(frame)
        return () => {
            cancelAnimationFrame(raf)
            drawRef.current = null
        }
    }, [accent, surface, hairlineColor, mutedColor, showResting, width, height])

    // ---- hover hit-testing ----
    function handleMove(e: { clientX: number }) {
        if (!showTooltip) return
        const cv = canvasRef.current
        const m = mapRef.current
        const p = pulseRef.current
        if (!cv || !m || !p.series.length) return

        const rect = cv.getBoundingClientRect()
        const mx = e.clientX - rect.left

        // Invert the x mapping to a timestamp, then take the nearest real sample.
        const target = m.t0 + (mx / Math.max(1, m.w - 10)) * m.span
        let best = 0
        let bestD = Infinity
        for (let i = 0; i < p.series.length; i++) {
            const d = Math.abs(p.series[i].t - target)
            if (d < bestD) {
                bestD = d
                best = i
            }
        }

        if (hoverRef.current !== best) {
            hoverRef.current = best
            if (drawRef.current) drawRef.current(1)
        }

        const pt = p.series[best]
        const px = ((pt.t - m.t0) / m.span) * (m.w - 10)
        const py =
            m.padTop + (1 - (pt.v - m.lo) / (m.hi - m.lo)) * (m.h - m.padTop - m.padBottom)

        const wRect = widgetRef.current?.getBoundingClientRect()
        setTip({ title: `${pt.v} bpm`, sub: clockTime(pt.t) })
        setAnchor({
            centerX: rect.left + px,
            top: rect.top + py - TIP_GAP,
            wLeft: wRect ? wRect.left : 0,
            wRight: wRect ? wRect.right : window.innerWidth,
        })
        setTipVisible(true)
    }

    function handleLeave() {
        hoverRef.current = null
        if (drawRef.current) drawRef.current(1)
        setTipVisible(false)
    }

    return (
        <div
            ref={widgetRef}
            style={{
                width,
                height,
                borderRadius: 16,
                padding: 20,
                backgroundColor: surface,
                boxShadow: WIDGET_SHADOW,
                overflow: "hidden",
                fontFamily: '"Geist", sans-serif',
                color: inkColor,
                boxSizing: "border-box",
                display: "flex",
                gap: 28,
            }}
        >
            <div
                style={{
                    width: 272,
                    flex: "none",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                }}
            >
                <div
                    style={{
                        fontWeight: 500,
                        fontSize: 11,
                        lineHeight: "1em",
                        letterSpacing: "0.4px",
                        textTransform: "uppercase",
                        color: mutedColor,
                    }}
                >
                    Pulse
                </div>

                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <div
                        ref={numeralRef}
                        style={{
                            fontSize: numeralSize,
                            fontWeight: 500,
                            lineHeight: "0.86em",
                            letterSpacing: -3,
                            color: inkColor,
                            fontVariantNumeric: "tabular-nums",
                            transformOrigin: "left center",
                            willChange: "transform",
                        }}
                    >
                        {pulse.bpm}
                    </div>
                    <div
                        style={{
                            fontSize: 13,
                            fontWeight: 500,
                            letterSpacing: "0.4px",
                            textTransform: "uppercase",
                            color: mutedColor,
                        }}
                    >
                        bpm
                    </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    <div
                        style={{
                            fontSize: 12,
                            lineHeight: 1.35,
                            color: mutedColor,
                            fontVariantNumeric: "tabular-nums",
                        }}
                    >
                        {pulse.restingHeartRate ? (
                            <>
                                Resting{" "}
                                <strong style={{ fontWeight: 500 }}>
                                    {pulse.restingHeartRate}
                                </strong>
                                {" · today "}
                            </>
                        ) : (
                            "Today "
                        )}
                        <strong style={{ fontWeight: 500 }}>
                            {pulse.min24h}&#8211;{pulse.max24h}
                        </strong>
                    </div>
                    <div
                        style={{
                            fontSize: 12,
                            lineHeight: 1.35,
                            color: mutedColor,
                            fontVariantNumeric: "tabular-nums",
                        }}
                    >
                        {relTime(pulse.lastSyncedAt)}
                    </div>
                </div>
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
                <canvas
                    ref={canvasRef}
                    onMouseMove={handleMove}
                    onMouseLeave={handleLeave}
                    style={{
                        display: "block",
                        width: "100%",
                        height: "100%",
                        cursor: showTooltip ? "crosshair" : "default",
                    }}
                />
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
                        <div style={{ color: tooltipTextColor, fontWeight: 500 }}>
                            {tip.title}
                        </div>
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
    accent: { type: ControlType.Color, title: "Accent", defaultValue: "#2784FC" },
    surface: { type: ControlType.Color, title: "Surface", defaultValue: "#FFFFFF" },
    inkColor: { type: ControlType.Color, title: "Text", defaultValue: "#2B2B2B" },
    mutedColor: { type: ControlType.Color, title: "Muted", defaultValue: "#7A7A7A" },
    hairlineColor: {
        type: ControlType.Color,
        title: "Hairline",
        defaultValue: "#EBEBEB",
    },
    showResting: {
        type: ControlType.Boolean,
        title: "Resting line",
        defaultValue: true,
    },
    numeralSize: {
        type: ControlType.Number,
        title: "Numeral",
        defaultValue: 84,
        min: 40,
        max: 140,
        step: 1,
    },
    refreshSeconds: {
        type: ControlType.Number,
        title: "Refresh",
        defaultValue: 300,
        min: 30,
        max: 3600,
        step: 30,
        description: "Seconds between refetches.",
    },
    showTooltip: {
        type: ControlType.Boolean,
        title: "Tooltip",
        defaultValue: true,
    },
    tooltipBg: {
        type: ControlType.Color,
        title: "Tip bg",
        defaultValue: "#2B2B2B",
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipTextColor: {
        type: ControlType.Color,
        title: "Tip text",
        defaultValue: "#FFFFFF",
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipSubColor: {
        type: ControlType.Color,
        title: "Tip sub",
        defaultValue: "#E0E0E0",
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipFontSize: {
        type: ControlType.Number,
        title: "Tip size",
        defaultValue: 11,
        min: 8,
        max: 20,
        step: 1,
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipFontWeight: {
        type: ControlType.Number,
        title: "Tip weight",
        defaultValue: 400,
        min: 100,
        max: 900,
        step: 100,
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipPaddingX: {
        type: ControlType.Number,
        title: "Tip pad X",
        defaultValue: 9,
        min: 0,
        max: 32,
        step: 1,
        hidden: (p: any) => !p.showTooltip,
    },
    tooltipPaddingY: {
        type: ControlType.Number,
        title: "Tip pad Y",
        defaultValue: 5,
        min: 0,
        max: 32,
        step: 1,
        hidden: (p: any) => !p.showTooltip,
    },
})
