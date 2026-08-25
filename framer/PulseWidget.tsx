import { useEffect, useRef, useState } from "react"
import { addPropertyControls, ControlType } from "framer"

/**
 * Pulse — XL widget (1200 × 288)
 *
 * Draws the real 24h heart-rate series from garmin-pulse-api. Every point on the
 * line is a reading the watch actually took; the only animated element is the
 * marker at the live end, which beats at the real current BPM.
 *
 * NOTE: Framer's canvas blocks external fetch, so on canvas this falls back to a
 * baked-in sample and says so. Real data only appears on the published site.
 */

const WIDGET_SHADOW =
    "rgba(14, 92, 126, 0.04) 0px 0px 0px 1px, rgba(42, 61, 69, 0.04) 0px 1px 1px -0.5px, rgba(42, 62, 70, 0.04) 0px 3px 3px -1.5px, rgba(42, 62, 70, 0.04) 0px 6px 6px -3px"

// Real readings, thinned, so the canvas preview shows a truthful shape.
const SAMPLE_RAW =
    "0,83;26,80;42,65;58,64;74,61;90,61;106,62;122,78;138,60;154,63;170,54;186,52;202,52;218,53;234,57;250,54;266,55;282,58;298,56;314,52;330,51;346,50;362,51;378,54;394,52;410,53;426,50;442,54;458,51;474,57;490,59;506,49;522,51;538,59"

type Point = { t: number; v: number }
type Pulse = {
    bpm: number
    restingHeartRate: number | null
    min24h: number
    max24h: number
    series: Point[]
    lastSyncedAt: string | null
    isSample: boolean
}

function buildSample(): Pulse {
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

export default function PulseWidget(props) {
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
    } = props

    const [pulse, setPulse] = useState<Pulse>(buildSample)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const numeralRef = useRef<HTMLDivElement>(null)
    const pulseRef = useRef<Pulse>(pulse)
    pulseRef.current = pulse

    // ---- data ----
    useEffect(() => {
        let cancelled = false

        async function load() {
            try {
                const res = await fetch(endpoint, { cache: "no-store" })
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                const d = await res.json()
                if (cancelled || !d || !Array.isArray(d.series24h) || !d.series24h.length) return
                setPulse({
                    bpm: d.bpm,
                    restingHeartRate: d.restingHeartRate,
                    min24h: d.min24h,
                    max24h: d.max24h,
                    series: d.series24h.map((p) => ({ t: p[0], v: p[1] })),
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
        const canvas = canvasRef.current
        if (!canvas) return
        const reduce =
            typeof window !== "undefined" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches

        let raf = 0

        function draw(phase: number) {
            const p = pulseRef.current
            const dpr = window.devicePixelRatio || 1
            const w = canvas.clientWidth
            const h = canvas.clientHeight
            if (!w || !h) return
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr)
                canvas.height = Math.round(h * dpr)
            }
            const ctx = canvas.getContext("2d")
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
            const X = (t: number) => ((t - t0) / span) * (w - 10)
            const Y = (v: number) => padTop + (1 - (v - lo) / (hi - lo)) * (h - padTop - padBottom)

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
        }

        if (reduce) {
            draw(1)
            return
        }

        const frame = (now: number) => {
            const beatMs = 60000 / Math.max(30, pulseRef.current.bpm || 60)
            const phase = ((now / beatMs) % 1 + 1) % 1
            draw(phase)
            if (numeralRef.current) {
                const s = phase < 0.14 ? 1 + (1 - phase / 0.14) * 0.022 : 1
                numeralRef.current.style.transform = `scale(${s.toFixed(4)})`
            }
            raf = requestAnimationFrame(frame)
        }
        raf = requestAnimationFrame(frame)
        return () => cancelAnimationFrame(raf)
    }, [accent, hairlineColor, mutedColor, showResting, width, height])

    return (
        <div
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
                                Resting <strong style={{ fontWeight: 500 }}>{pulse.restingHeartRate}</strong>
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
                <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
            </div>
        </div>
    )
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

PulseWidget.defaultProps = { width: 1200, height: 288 }

addPropertyControls(PulseWidget, {
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
    hairlineColor: { type: ControlType.Color, title: "Hairline", defaultValue: "#EBEBEB" },
    showResting: { type: ControlType.Boolean, title: "Resting line", defaultValue: true },
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
})
