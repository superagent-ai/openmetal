"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type Star = {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  phase: number;
  driftX: number;
  driftY: number;
};

type Meteor = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  width: number;
  life: number;
  maxLife: number;
  brightness: number;
};

function rgbChannels(color: string): string {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return "255,255,255";
  probe.fillStyle = "#000000";
  probe.fillStyle = color;
  const normalized = probe.fillStyle;
  if (typeof normalized === "string" && normalized.startsWith("#") && normalized.length === 7) {
    return `${Number.parseInt(normalized.slice(1, 3), 16)},${Number.parseInt(normalized.slice(3, 5), 16)},${Number.parseInt(normalized.slice(5, 7), 16)}`;
  }
  const match = String(normalized).match(/[\d.]+/g);
  if (!match || match.length < 3) return "255,255,255";
  return `${match[0]},${match[1]},${match[2]}`;
}

function createStars(width: number, height: number): Star[] {
  const count = Math.min(90, Math.max(18, Math.round((width * height) / 6500)));
  return Array.from({ length: count }, () => {
    const depth = Math.random();
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      radius: 0.35 + depth * 1.15,
      alpha: 0.2 + depth * 0.6,
      phase: Math.random() * Math.PI * 2,
      driftX: (0.35 + depth * 1.2) * (Math.random() < 0.5 ? -1 : 1),
      driftY: 1.2 + depth * 3.2,
    };
  });
}

function spawnMeteor(width: number, height: number): Meteor {
  const roll = Math.random();
  const speed = 480 + Math.random() * 440;
  let x = 0;
  let y = 0;
  let angle = 0;

  if (roll < 0.42) {
    x = -24;
    y = Math.random() * height * 0.7;
    angle = ((8 + Math.random() * 24) * Math.PI) / 180;
  } else if (roll < 0.84) {
    x = width + 24;
    y = Math.random() * height * 0.7;
    angle = Math.PI - ((8 + Math.random() * 24) * Math.PI) / 180;
  } else {
    x = Math.random() * width;
    y = -24;
    const tilt = ((Math.random() < 0.5 ? -1 : 1) * ((12 + Math.random() * 26) * Math.PI)) / 180;
    angle = Math.PI / 2 + tilt;
  }

  const length = 110 + Math.random() * 120;
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    length,
    width: 1.05 + Math.random() * 0.65,
    life: 0,
    maxLife: (Math.hypot(width, height) + length + 60) / speed,
    brightness: 0.7 + Math.random() * 0.3,
  };
}

export function ShootingStars({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let color = "255,255,255";
    let frame = 0;
    let visible = true;
    let nextSpawn = 0;
    let lastTime = 0;

    const readColor = () => {
      color = rgbChannels(getComputedStyle(canvas).color);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, rect.width);
      const nextHeight = Math.max(1, rect.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const changed = Math.abs(nextWidth - width) > 0.5 || Math.abs(nextHeight - height) > 0.5;
      width = nextWidth;
      height = nextHeight;
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      if (changed || stars.length === 0) stars = createStars(width, height);
    };

    const draw = (time: number) => {
      const delta = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      context.clearRect(0, 0, width, height);

      const animate = !reducedMotion.matches;
      for (const star of stars) {
        if (animate && delta > 0) {
          star.x += star.driftX * delta;
          star.y += star.driftY * delta;
          if (star.x < -2) star.x = width + 2;
          if (star.x > width + 2) star.x = -2;
          if (star.y > height + 2) star.y = -2;
        }
        const twinkle = animate ? 0.55 + 0.45 * Math.sin(time * 0.0012 + star.phase) : 1;
        context.beginPath();
        context.fillStyle = `rgba(${color}, ${star.alpha * twinkle})`;
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
      }

      if (!animate) return;

      if (time >= nextSpawn && meteors.length < 2) {
        meteors.push(spawnMeteor(width, height));
        nextSpawn = time + 650 + Math.random() * 1300;
      }

      for (let index = meteors.length - 1; index >= 0; index -= 1) {
        const meteor = meteors[index];
        if (!meteor) continue;
        meteor.life += delta;
        meteor.x += meteor.vx * delta;
        meteor.y += meteor.vy * delta;
        const travel = Math.hypot(meteor.vx, meteor.vy) || 1;
        const tailX = meteor.x - (meteor.vx / travel) * meteor.length;
        const tailY = meteor.y - (meteor.vy / travel) * meteor.length;
        const fadeIn = Math.min(1, meteor.life / 0.08);
        const fadeOut =
          meteor.life > meteor.maxLife * 0.72
            ? Math.max(0, (meteor.maxLife - meteor.life) / (meteor.maxLife * 0.28))
            : 1;
        const alpha = fadeIn * fadeOut * meteor.brightness;
        const gradient = context.createLinearGradient(tailX, tailY, meteor.x, meteor.y);
        gradient.addColorStop(0, `rgba(${color}, 0)`);
        gradient.addColorStop(0.45, `rgba(${color}, ${0.12 * alpha})`);
        gradient.addColorStop(0.82, `rgba(${color}, ${0.55 * alpha})`);
        gradient.addColorStop(1, `rgba(${color}, ${alpha})`);
        context.strokeStyle = gradient;
        context.lineWidth = meteor.width;
        context.lineCap = "round";
        context.shadowColor = `rgba(${color}, ${0.45 * alpha})`;
        context.shadowBlur = 8;
        context.beginPath();
        context.moveTo(tailX, tailY);
        context.lineTo(meteor.x, meteor.y);
        context.stroke();
        context.shadowBlur = 0;
        context.beginPath();
        context.fillStyle = `rgba(${color}, ${alpha})`;
        context.arc(meteor.x, meteor.y, meteor.width * 0.8, 0, Math.PI * 2);
        context.fill();

        const gone =
          meteor.life > meteor.maxLife ||
          meteor.x < -meteor.length - 40 ||
          meteor.x > width + meteor.length + 40 ||
          meteor.y > height + meteor.length + 40 ||
          meteor.y < -meteor.length - 80;
        if (gone) meteors.splice(index, 1);
      }
    };

    const loop = (time: number) => {
      if (!visible) return;
      draw(time);
      if (!reducedMotion.matches) frame = window.requestAnimationFrame(loop);
    };

    const start = () => {
      window.cancelAnimationFrame(frame);
      readColor();
      resize();
      lastTime = 0;
      nextSpawn = performance.now() + 180;
      if (!visible) return;
      frame = window.requestAnimationFrame(loop);
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reducedMotion.matches) draw(performance.now());
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible) start();
      else window.cancelAnimationFrame(frame);
    });
    intersectionObserver.observe(canvas);

    const themeObserver = new MutationObserver(() => {
      readColor();
      if (reducedMotion.matches) draw(performance.now());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const onMotionChange = () => {
      meteors = [];
      start();
    };
    reducedMotion.addEventListener("change", onMotionChange);

    const onVisibilityChange = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frame);
        return;
      }
      if (visible) start();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    start();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      themeObserver.disconnect();
      reducedMotion.removeEventListener("change", onMotionChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 size-full text-foreground [mask-image:linear-gradient(to_bottom,transparent,black_12%,black_80%,transparent)]",
        className,
      )}
    />
  );
}
