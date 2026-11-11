import { useEffect, useRef } from 'react';

type Project = { id: string; name: string; color: string };
type Point = { t: number; p: number };

/** Isolated S-level relative-strength preview: real /ws/live quotes, time-based x, rAF interpolation. */
export function LiveStrengthChart({ projects, language }: { projects: Project[]; language: 'zh' | 'en' }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const data = useRef(new Map<string, Point[]>());
  const shown = useRef(new Map<string, number>());
  const target = useRef(new Map<string, number>());
  const zh = language === 'zh';

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry = 1_000;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws/live`);
      socket.onopen = () => { retry = 1_000; socket?.send(JSON.stringify({ op: 'subscribe', projects: projects.map((p) => p.id), channels: ['quotes'] })); };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (!Array.isArray(message.ticks)) return;
          const now = Date.now();
          for (const tick of message.ticks) {
            if (typeof tick.projectId !== 'string' || !Number.isFinite(tick.price)) continue;
            const list = data.current.get(tick.projectId) ?? [];
            list.push({ t: now, p: tick.price });
            while (list.length && list[0].t < now - 60_000) list.shift();
            data.current.set(tick.projectId, list);
          }
        } catch { /* ignore */ }
      };
      socket.onclose = () => { if (!closed) { setTimeout(connect, retry); retry = Math.min(15_000, retry * 1.7); } };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { closed = true; socket?.close(); };
  }, [projects]);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const dt = Math.min(0.2, (now - last) / 1000); last = now;
      const el = canvas.current; if (!el) return;
      const ratio = window.devicePixelRatio || 1;
      const width = el.clientWidth, height = el.clientHeight;
      if (el.width !== width * ratio || el.height !== height * ratio) { el.width = width * ratio; el.height = height * ratio; }
      const ctx = el.getContext('2d'); if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#070b0a'; ctx.fillRect(0, 0, width, height);
      const end = Date.now(), start = end - 60_000;
      const left = 44, right = 12, top = 16, bottom = 24;
      const values: number[] = [];
      for (const project of projects) {
        const list = data.current.get(project.id) ?? [];
        if (!list.length) continue;
        const anchor = list[0].p;
        const value = list.at(-1)!.p / anchor - 1;
        values.push(value * 100);
        target.current.set(project.id, value);
      }
      const bound = Math.max(0.2, ...values.map(Math.abs));
      const x = (t: number) => left + (t - start) / 60_000 * (width - left - right);
      const y = (v: number) => top + (1 - (v + bound) / (bound * 2)) * (height - top - bottom);
      ctx.strokeStyle = '#1b2724'; ctx.lineWidth = 1;
      for (const factor of [-1, -0.5, 0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(left, y(bound * factor)); ctx.lineTo(width - right, y(bound * factor)); ctx.stroke(); }
      ctx.font = '10px ui-monospace, monospace'; ctx.fillStyle = '#64756f';
      ctx.fillText(`${(bound * 100).toFixed(2)}%`, 4, y(bound) + 3);
      ctx.fillText('0%', 4, y(0) + 3);
      ctx.fillText(`-${(bound * 100).toFixed(2)}%`, 4, y(-bound) + 3);
      for (const project of projects) {
        const list = data.current.get(project.id) ?? [];
        if (!list.length) continue;
        const targetValue = target.current.get(project.id) ?? 0;
        const current = shown.current.get(project.id) ?? targetValue;
        const next = current + (targetValue - current) * Math.min(1, dt * 4);
        shown.current.set(project.id, next);
        ctx.strokeStyle = project.color; ctx.lineWidth = 1.8; ctx.beginPath();
        list.forEach((point, index) => { const px = x(point.t), py = y(index === list.length - 1 ? next : point.p / list[0].p - 1); if (index) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.stroke();
        const lastPoint = list.at(-1)!;
        ctx.fillStyle = project.color; ctx.beginPath(); ctx.arc(x(lastPoint.t), y(next), 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillText(`${project.name} ${(next * 100).toFixed(2)}%`, Math.min(width - 120, x(lastPoint.t) + 8), y(next) - 6);
      }
      if (!data.current.size) { ctx.fillStyle = '#8a9b95'; ctx.fillText(zh ? '等待实时报价…' : 'Waiting for live quotes…', left, height / 2); }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [projects, zh]);

  return <canvas ref={canvas} style={{ width: '100%', height: '100%', display: 'block' }} aria-label={zh ? 'S 级相对强弱测试图' : 'S-level relative strength preview'} />;
}
