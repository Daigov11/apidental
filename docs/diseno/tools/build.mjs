#!/usr/bin/env node
/**
 * Fuente única de los tokens de diseño de ApiDental.
 *   node docs/diseno/tools/build.mjs          -> genera tokens.json, tokens.css y vista-previa.html
 *   node docs/diseno/tools/build.mjs --check  -> solo valida contrastes (sale con código 1 si alguno falla)
 * Sin dependencias. Los valores son PROPIOS de ApiDental (no derivan de ninguna otra marca).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- primitivos
export const palette = {
  // "Laguna": azul-verdoso sereno y clínico. Color de marca y acciones.
  brand: { 50: '#ECFAFB', 100: '#D3F1F4', 200: '#A6E2E9', 300: '#6FCBD7', 400: '#37B0C0', 500: '#1796A8', 600: '#0F7889', 700: '#0D6070', 800: '#104E5B', 900: '#123F4A' },
  // "Ámbar": acento cálido, solo para fidelización/destacados (nunca para estados clínicos o de error).
  accent: { 50: '#FFF8EA', 100: '#FDEBC8', 300: '#F6C566', 500: '#EE9F1F', 700: '#8F5A06', 800: '#6F4504' },
  // Neutros fríos (pizarra).
  neutral: { 0: '#FFFFFF', 25: '#F7F9FA', 50: '#EFF3F5', 100: '#E3E9ED', 200: '#CFD8DE', 300: '#AFBDC6', 400: '#8696A3', 500: '#5F7280', 600: '#475965', 700: '#344550', 800: '#222F39', 900: '#141E26' },
  success: { 50: '#E8F6EE', 500: '#1E8A4C', 700: '#14633A' },
  warning: { 50: '#FFF4DB', 500: '#C27803', 700: '#7A4B00' },
  danger: { 50: '#FDECEA', 500: '#CC3B32', 700: '#992820' },
  info: { 50: '#E8F1FB', 500: '#2B6CB0', 700: '#1E4E85' },
};
const P = palette;

// ---------------------------------------------------------------- semánticos
export const semantic = {
  'bg-app': P.neutral[25], 'bg-surface': P.neutral[0], 'bg-subtle': P.neutral[50], 'bg-sidebar': P.neutral[900], 'bg-overlay': 'rgba(20, 30, 38, 0.55)',
  'text-default': P.neutral[900], 'text-muted': P.neutral[600], 'text-subtle': P.neutral[500], 'text-on-brand': P.neutral[0], 'text-on-sidebar': P.neutral[0], 'text-on-sidebar-muted': P.neutral[300],
  'border-default': P.neutral[200], 'border-strong': P.neutral[400], 'border-subtle': P.neutral[100],
  'action-primary': P.brand[600], 'action-primary-hover': P.brand[700], 'action-primary-active': P.brand[800], 'action-danger': P.danger[500], 'action-danger-hover': P.danger[700],
  link: P.brand[700], 'focus-ring': P.brand[600], 'selection-bg': P.brand[100],
  'state-success-bg': P.success[50], 'state-success-fg': P.success[700], 'state-success-icon': P.success[500],
  'state-warning-bg': P.warning[50], 'state-warning-fg': P.warning[700], 'state-warning-icon': P.warning[500],
  'state-danger-bg': P.danger[50], 'state-danger-fg': P.danger[700], 'state-danger-icon': P.danger[500],
  'state-info-bg': P.info[50], 'state-info-fg': P.info[700], 'state-info-icon': P.info[500],
  'state-neutral-bg': P.neutral[50], 'state-neutral-fg': P.neutral[700],
  'state-brand-bg': P.brand[100], 'state-brand-fg': P.brand[800],
  'state-accent-bg': P.accent[100], 'state-accent-fg': P.accent[800],
};

export const typography = {
  families: {
    ui: "'Inter', 'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif",
    display: "'Manrope', 'Inter', 'Segoe UI', system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
  // rem (1rem = 16px). El panel usa 15px de base para cuadrar densidad y legibilidad.
  scale: {
    'display': { size: '3rem', line: '1.1', weight: 800, family: 'display', use: 'Solo sitio comercial (hero)' },
    'h1': { size: '1.75rem', line: '1.25', weight: 700, family: 'display', use: 'Título de pantalla' },
    'h2': { size: '1.375rem', line: '1.3', weight: 700, family: 'display', use: 'Sección dentro de una pantalla' },
    'h3': { size: '1.125rem', line: '1.35', weight: 600, family: 'ui', use: 'Título de tarjeta' },
    'body': { size: '0.9375rem', line: '1.5', weight: 400, family: 'ui', use: 'Texto base del panel (15 px)' },
    'body-strong': { size: '0.9375rem', line: '1.5', weight: 600, family: 'ui', use: 'Etiquetas y datos clave' },
    'table': { size: '0.875rem', line: '1.4', weight: 400, family: 'ui', use: 'Celdas de tabla (14 px)' },
    'caption': { size: '0.8125rem', line: '1.4', weight: 400, family: 'ui', use: 'Ayudas y metadatos (13 px, mínimo permitido)' },
    'overline': { size: '0.75rem', line: '1.3', weight: 600, family: 'ui', use: 'Encabezados de grupo en mayúsculas (12 px, solo decorativo)' },
  },
};

export const spacing = { 0: '0', 1: '0.125rem', 2: '0.25rem', 3: '0.5rem', 4: '0.75rem', 5: '1rem', 6: '1.25rem', 7: '1.5rem', 8: '2rem', 9: '2.5rem', 10: '3rem', 11: '4rem', 12: '5rem' };
export const radius = { xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px', full: '999px' };
export const shadow = {
  none: 'none',
  sm: '0 1px 2px rgba(20, 30, 38, 0.06)',
  md: '0 4px 12px rgba(20, 30, 38, 0.08)',
  lg: '0 12px 32px rgba(20, 30, 38, 0.16)',
  focus: '0 0 0 2px #FFFFFF, 0 0 0 4px #0F7889',
};
export const motion = { fast: '100ms', base: '160ms', slow: '240ms', easing: 'cubic-bezier(0.2, 0, 0, 1)' };
export const breakpoints = { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' };
export const layout = { 'sidebar-width': '248px', 'sidebar-width-collapsed': '72px', 'topbar-height': '56px', 'content-max': '1280px', 'form-max': '720px', 'touch-target': '44px', 'control-height-md': '40px', 'control-height-sm': '32px', 'row-height-comfortable': '48px', 'row-height-compact': '36px' };
export const zIndex = { base: 0, sticky: 10, dropdown: 20, drawer: 30, modal: 40, toast: 50 };

// Estados de dominio -> tono semántico (siempre con icono + texto; nunca solo color).
export const statusMap = {
  cita: { reservado: 'info', confirmado: 'brand', atendido: 'success', cancelado: 'neutral', ausente: 'danger' },
  pago: { pagado: 'success', parcial: 'warning', pendiente: 'neutral', credito: 'accent', anulado: 'neutral' },
  comprobante: { pendiente_envio: 'neutral', enviado: 'info', emitido: 'success', rechazado: 'danger', error_reintentable: 'warning', requiere_conciliacion: 'warning', anulacion_pendiente: 'warning', anulado: 'neutral' },
  consentimiento: { vigente: 'success', revocado: 'neutral', sin_registro: 'warning' },
  paciente: { activo: 'success', inactivo: 'neutral', menor_sin_representante: 'warning', posible_duplicado: 'warning' },
  stock: { ok: 'success', bajo: 'warning', agotado: 'danger' },
};

// Convención clásica de odontograma (rojo = patología/por tratar, azul = realizado). Formato MINSA: POR VALIDAR.
export const odontogram = {
  pendiente: { color: '#CC3B32', label: 'Patología / por tratar' },
  realizado: { color: '#2B6CB0', label: 'Tratamiento realizado' },
  ausente: { color: '#475965', label: 'Pieza ausente' },
  sano: { color: '#AFBDC6', label: 'Sano / sin registro' },
  seleccion: { color: '#0F7889', label: 'Selección actual' },
};

// ---------------------------------------------------------------- contraste
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };

export const pairs = [
  ['Texto principal sobre fondo de la app', 'text-default', 'bg-app', 7],
  ['Texto principal sobre tarjeta', 'text-default', 'bg-surface', 7],
  ['Texto secundario sobre tarjeta', 'text-muted', 'bg-surface', 4.5],
  ['Texto secundario sobre fondo de la app', 'text-muted', 'bg-app', 4.5],
  ['Texto de apoyo / placeholder sobre blanco', 'text-subtle', 'bg-surface', 4.5],
  ['Botón primario (texto blanco)', 'text-on-brand', 'action-primary', 4.5],
  ['Botón primario, hover', 'text-on-brand', 'action-primary-hover', 4.5],
  ['Botón peligro (texto blanco)', 'text-on-brand', 'action-danger', 4.5],
  ['Enlace sobre blanco', 'link', 'bg-surface', 4.5],
  ['Texto de marca sobre tinte de marca', 'state-brand-fg', 'state-brand-bg', 4.5],
  ['Badge éxito', 'state-success-fg', 'state-success-bg', 4.5],
  ['Badge advertencia', 'state-warning-fg', 'state-warning-bg', 4.5],
  ['Badge peligro', 'state-danger-fg', 'state-danger-bg', 4.5],
  ['Badge información', 'state-info-fg', 'state-info-bg', 4.5],
  ['Badge neutro', 'state-neutral-fg', 'state-neutral-bg', 4.5],
  ['Badge fidelización (acento)', 'state-accent-fg', 'state-accent-bg', 4.5],
  ['Anillo de foco sobre blanco (UI ≥ 3:1)', 'focus-ring', 'bg-surface', 3],
  ['Borde de campo sobre blanco (UI ≥ 3:1)', 'border-strong', 'bg-surface', 3],
  ['Icono de éxito sobre blanco (UI ≥ 3:1)', 'state-success-icon', 'bg-surface', 3],
  ['Icono de advertencia sobre blanco (UI ≥ 3:1)', 'state-warning-icon', 'bg-surface', 3],
  ['Icono de peligro sobre blanco (UI ≥ 3:1)', 'state-danger-icon', 'bg-surface', 3],
  ['Icono de información sobre blanco (UI ≥ 3:1)', 'state-info-icon', 'bg-surface', 3],
  ['Texto sobre barra lateral', 'text-on-sidebar', 'bg-sidebar', 7],
  ['Texto secundario sobre barra lateral', 'text-on-sidebar-muted', 'bg-sidebar', 4.5],
  ['Odontograma: patología sobre blanco (UI ≥ 3:1)', ['odontogram', 'pendiente'], 'bg-surface', 3],
  ['Odontograma: realizado sobre blanco (UI ≥ 3:1)', ['odontogram', 'realizado'], 'bg-surface', 3],
  ['Odontograma: pieza ausente sobre blanco (UI ≥ 3:1)', ['odontogram', 'ausente'], 'bg-surface', 3],
];
const colorOf = (k) => (Array.isArray(k) ? odontogram[k[1]].color : semantic[k]);
export const results = pairs.map(([label, fg, bg, min]) => {
  const f = colorOf(fg), b = colorOf(bg);
  return { label, fg: f, bg: b, min, ratio: ratio(f, b), ok: ratio(f, b) >= min };
});

const failed = results.filter((r) => !r.ok);
if (process.argv.includes('--check')) {
  for (const r of results) console.log(`${r.ok ? 'OK   ' : 'FALLA'} ${r.ratio.toFixed(2).padStart(5)}:1 (mín ${r.min})  ${r.label}`);
  console.log(failed.length ? `\n${failed.length} combinaciones NO cumplen WCAG 2.2 AA` : `\n${results.length} combinaciones cumplen WCAG 2.2 AA`);
  process.exit(failed.length ? 1 : 0);
}
if (failed.length) {
  console.error('Contraste insuficiente:', failed.map((f) => f.label).join('; '));
  process.exit(1);
}

// ---------------------------------------------------------------- salidas
const tokensJson = { $description: 'Tokens de diseño de ApiDental. Generado por tools/build.mjs; no editar a mano.', color: { primitive: palette, semantic }, typography, spacing, radius, shadow, motion, breakpoints, layout, zIndex, status: statusMap, odontogram };
writeFileSync(join(OUT, 'tokens.json'), JSON.stringify(tokensJson, null, 2) + '\n');

const css = [];
css.push('/* Tokens de diseño de ApiDental. Generado por tools/build.mjs; no editar a mano. */', ':root {');
for (const [group, scale] of Object.entries(palette)) for (const [k, v] of Object.entries(scale)) css.push(`  --color-${group}-${k}: ${v};`);
for (const [k, v] of Object.entries(semantic)) css.push(`  --${k}: ${v};`);
for (const [k, v] of Object.entries(typography.families)) css.push(`  --font-${k}: ${v};`);
for (const [k, v] of Object.entries(typography.scale)) css.push(`  --text-${k}-size: ${v.size};`, `  --text-${k}-line: ${v.line};`, `  --text-${k}-weight: ${v.weight};`);
for (const [k, v] of Object.entries(spacing)) css.push(`  --space-${k}: ${v};`);
for (const [k, v] of Object.entries(radius)) css.push(`  --radius-${k}: ${v};`);
for (const [k, v] of Object.entries(shadow)) css.push(`  --shadow-${k}: ${v};`);
for (const [k, v] of Object.entries(motion)) css.push(`  --motion-${k}: ${v};`);
for (const [k, v] of Object.entries(layout)) css.push(`  --${k}: ${v};`);
for (const [k, v] of Object.entries(zIndex)) css.push(`  --z-${k}: ${v};`);
for (const [k, v] of Object.entries(odontogram)) css.push(`  --odonto-${k}: ${v.color};`);
css.push('}', '', '@media (prefers-reduced-motion: reduce) {', '  :root { --motion-fast: 0ms; --motion-base: 0ms; --motion-slow: 0ms; }', '}', '');
writeFileSync(join(OUT, 'tokens.css'), css.join('\n'));

// ---------- vista previa estática (sin dependencias ni recursos externos)
const swatch = (name, scale) => `<div class="sw-row"><div class="sw-name">${name}</div>${Object.entries(scale).map(([k, v]) => `<div class="sw" style="background:${v};color:${ratio(v, '#FFFFFF') >= 4.5 ? '#fff' : '#141E26'}"><b>${k}</b><span>${v}</span></div>`).join('')}</div>`;
const tone = (t) => ({ info: 'info', brand: 'brand', success: 'success', neutral: 'neutral', danger: 'danger', warning: 'warning', accent: 'accent' })[t];
const icon = { info: '●', brand: '◆', success: '✓', neutral: '–', danger: '✕', warning: '!', accent: '★' };
const LABELS = { credito: 'Crédito', anulacion_pendiente: 'Anulación pendiente', requiere_conciliacion: 'Requiere conciliación', error_reintentable: 'Error reintentable', pendiente_envio: 'Pendiente de envío', menor_sin_representante: 'Menor sin representante', ok: 'Stock suficiente', bajo: 'Stock bajo', agotado: 'Agotado', sin_registro: 'Sin registro' };
const label = (s) => LABELS[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const badge = (s, t) => `<span class="badge b-${tone(t)}"><i aria-hidden="true">${icon[t]}</i>${label(s)}</span>`;
const badges = (m) => Object.entries(m).map(([s, t]) => badge(s, t)).join(' ');
const typeRows = Object.entries(typography.scale).map(([k, v]) => `<div class="ty"><code>${k}</code><span style="font-family:var(--font-${v.family});font-size:${v.size};font-weight:${v.weight};line-height:${v.line}">Atención odontológica clara y a tiempo</span><small>${v.size} · ${v.weight} · ${v.use}</small></div>`).join('');
const contrastRows = results.map((r) => `<tr><td>${r.label}</td><td><span class="chip" style="background:${r.bg};color:${r.fg}">Aa</span></td><td>${r.ratio.toFixed(2)} : 1</td><td>≥ ${r.min}</td><td><span class="badge b-success"><i aria-hidden="true">✓</i>Cumple</span></td></tr>`).join('');
const odonto = Object.entries(odontogram).map(([k, v]) => `<span class="od"><i style="background:${v.color}"></i>${v.label}</span>`).join('');
const mark = `<svg viewBox="0 0 40 40" width="40" height="40" role="img" aria-label="Marca provisional de ApiDental"><rect width="40" height="40" rx="11" fill="#0F7889"/><path d="M12 14.5c0-2.5 2-4.5 4.6-4.5 1.4 0 2.4.5 3.4 1 1-.5 2-1 3.4-1 2.6 0 4.6 2 4.6 4.5 0 2.2-.8 3.6-1.4 5.3-.7 2-.9 4.4-1.6 6.2-.4 1.1-1.2 1.5-2 1.5s-1.4-.7-1.8-2.2c-.3-1.1-.5-2.6-1.2-2.6s-.9 1.5-1.2 2.6c-.4 1.5-1 2.2-1.8 2.2s-1.6-.4-2-1.5c-.7-1.8-.9-4.2-1.6-6.2-.6-1.7-1.4-3.100-1.4-5.300Z" fill="#fff"/><circle cx="30.500" cy="10" r="3" fill="#EE9F1F"/></svg>`;

const html = `<!doctype html>
<html lang="es-PE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ApiDental · Vista previa del sistema de diseño</title>
<style>
${css.join('\n').replace('/* Tokens de diseño de ApiDental. Generado por tools/build.mjs; no editar a mano. */', '')}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-app);color:var(--text-default);font:400 var(--text-body-size)/1.5 var(--font-ui)}
h1,h2,h3{font-family:var(--font-display);margin:0}
main{max-width:1180px;margin:0 auto;padding:var(--space-8) var(--space-5) var(--space-12)}
section{margin-top:var(--space-10)}
h2{font-size:var(--text-h2-size);margin-bottom:var(--space-5);padding-bottom:var(--space-3);border-bottom:1px solid var(--border-default)}
h3{font-size:var(--text-h3-size);font-family:var(--font-ui);margin:var(--space-6) 0 var(--space-3)}
.brand{display:flex;align-items:center;gap:var(--space-4)}
.brand b{font:800 1.5rem var(--font-display);letter-spacing:-.01em}.brand small{display:block;color:var(--text-muted)}
.note{background:var(--state-info-bg);color:var(--state-info-fg);border-radius:var(--radius-md);padding:var(--space-4) var(--space-5);margin:var(--space-5) 0}
.sw-row{display:flex;gap:var(--space-2);align-items:stretch;margin-bottom:var(--space-3);flex-wrap:wrap}
.sw-name{width:90px;font-weight:600;align-self:center}
.sw{flex:1;min-width:84px;border-radius:var(--radius-sm);padding:var(--space-3);display:flex;flex-direction:column;font-size:.75rem;border:1px solid rgba(0,0,0,.06)}
.sw span{opacity:.9}
.ty{display:grid;grid-template-columns:110px 1fr;gap:var(--space-2) var(--space-5);align-items:baseline;padding:var(--space-3) 0;border-bottom:1px solid var(--border-subtle)}
.ty small{grid-column:2;color:var(--text-muted);font-size:var(--text-caption-size)}.ty code{color:var(--text-muted)}
.grid{display:grid;gap:var(--space-5);grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.card{background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-6)}
.card.elevated{box-shadow:var(--shadow-md);border-color:var(--border-subtle)}
.btn{display:inline-flex;align-items:center;gap:var(--space-3);height:var(--control-height-md);padding:0 var(--space-5);border-radius:var(--radius-md);font:600 var(--text-body-size)/1 var(--font-ui);border:1px solid transparent;cursor:pointer;transition:background var(--motion-base) var(--motion-easing)}
.btn:focus-visible,.field:focus-visible,a:focus-visible{outline:none;box-shadow:var(--shadow-focus)}
.btn-primary{background:var(--action-primary);color:var(--text-on-brand)}.btn-primary:hover{background:var(--action-primary-hover)}
.btn-secondary{background:var(--bg-surface);color:var(--text-default);border-color:var(--border-strong)}.btn-secondary:hover{background:var(--bg-subtle)}
.btn-ghost{background:transparent;color:var(--link)}.btn-ghost:hover{background:var(--state-brand-bg)}
.btn-danger{background:var(--action-danger);color:var(--text-on-brand)}
.btn[disabled]{background:var(--bg-subtle);color:var(--text-subtle);border-color:var(--border-default);cursor:not-allowed}
.btn-sm{height:var(--control-height-sm);padding:0 var(--space-4)}
.row{display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:center}
label{display:block;font-weight:600;margin-bottom:var(--space-2)}.hint{color:var(--text-muted);font-size:var(--text-caption-size);margin-top:var(--space-2)}
.field{width:100%;height:var(--control-height-md);padding:0 var(--space-4);border:1px solid var(--border-strong);border-radius:var(--radius-md);font:inherit;background:var(--bg-surface);color:inherit}
.field.err{border-color:var(--state-danger-icon);border-width:2px}.err-msg{color:var(--state-danger-fg);font-size:var(--text-caption-size);margin-top:var(--space-2);display:flex;gap:var(--space-2)}
.badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:var(--radius-full);font:600 var(--text-caption-size)/1 var(--font-ui);margin:2px 4px 2px 0}
.badge i{font-style:normal;font-size:.75rem}
.b-success{background:var(--state-success-bg);color:var(--state-success-fg)}.b-warning{background:var(--state-warning-bg);color:var(--state-warning-fg)}
.b-danger{background:var(--state-danger-bg);color:var(--state-danger-fg)}.b-info{background:var(--state-info-bg);color:var(--state-info-fg)}
.b-neutral{background:var(--state-neutral-bg);color:var(--state-neutral-fg)}.b-brand{background:var(--state-brand-bg);color:var(--state-brand-fg)}.b-accent{background:var(--state-accent-bg);color:var(--state-accent-fg)}
table{width:100%;border-collapse:collapse;font-size:var(--text-table-size)}
th{position:sticky;top:0;background:var(--bg-subtle);text-align:left;font-weight:600;color:var(--text-muted);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--border-default)}
td{padding:0 var(--space-4);height:var(--row-height-comfortable);border-bottom:1px solid var(--border-subtle)}tbody tr:hover{background:var(--bg-app)}
.tablewrap{background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);overflow:auto}
.alert{display:flex;gap:var(--space-4);padding:var(--space-4) var(--space-5);border-radius:var(--radius-md);border-left:4px solid;margin-bottom:var(--space-3)}
.alert b{display:block}.a-warning{background:var(--state-warning-bg);color:var(--state-warning-fg);border-color:var(--state-warning-icon)}
.a-danger{background:var(--state-danger-bg);color:var(--state-danger-fg);border-color:var(--state-danger-icon)}.a-success{background:var(--state-success-bg);color:var(--state-success-fg);border-color:var(--state-success-icon)}.a-info{background:var(--state-info-bg);color:var(--state-info-fg);border-color:var(--state-info-icon)}
.chip{display:inline-block;padding:2px 10px;border-radius:var(--radius-xs);font-weight:700;border:1px solid rgba(0,0,0,.08)}
.app{display:grid;grid-template-columns:var(--sidebar-width) 1fr;border:1px solid var(--border-default);border-radius:var(--radius-lg);overflow:hidden;min-height:420px}
.side{background:var(--bg-sidebar);color:var(--text-on-sidebar);padding:var(--space-5);display:flex;flex-direction:column;gap:var(--space-2)}
.ctx{background:rgba(255,255,255,.08);border-radius:var(--radius-md);padding:var(--space-3) var(--space-4);margin-bottom:var(--space-4);font-size:var(--text-caption-size)}.ctx small{display:block;color:var(--text-on-sidebar-muted)}
.nav a{display:flex;gap:var(--space-3);align-items:center;height:40px;padding:0 var(--space-4);border-radius:var(--radius-md);color:var(--text-on-sidebar-muted);text-decoration:none}
.nav a.on{background:var(--color-brand-600);color:#fff}.nav a:hover:not(.on){background:rgba(255,255,255,.08);color:#fff}
.main{background:var(--bg-app);padding:var(--space-6)}.top{display:flex;gap:var(--space-4);margin-bottom:var(--space-5)}.top .field{max-width:420px}
.tabs{display:flex;gap:var(--space-5);border-bottom:1px solid var(--border-default);margin:var(--space-5) 0}.tabs a{padding:var(--space-3) 0;color:var(--text-muted);text-decoration:none;font-weight:600}.tabs a.on{color:var(--link);border-bottom:3px solid var(--action-primary)}
.od{display:inline-flex;align-items:center;gap:var(--space-3);margin-right:var(--space-5)}.od i{width:14px;height:14px;border-radius:3px;display:inline-block}
.bars{display:flex;gap:var(--space-6);flex-wrap:wrap}.bar{background:var(--color-brand-600);height:20px;border-radius:var(--radius-full)}
@media(max-width:760px){.app{grid-template-columns:1fr}.side{display:none}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main>
<div class="brand">${mark}<div><b>ApiDental</b><small>by Apiworking · Vista previa del sistema de diseño (v0.1)</small></div></div>
<div class="note"><b>Propuesta propia, no definitiva.</b> Marca provisional (a validar con un diseñador). Los colores, la composición y los componentes son originales de ApiDental; esta página usa fuentes del sistema porque Inter y Manrope se autoalojarán al construir el panel. Generada por <code>tools/build.mjs</code>.</div>

<section><h2>1 · Paleta</h2>
${swatch('Laguna (marca)', palette.brand)}${swatch('Ámbar (acento)', palette.accent)}${swatch('Pizarra', palette.neutral)}
${swatch('Éxito', palette.success)}${swatch('Advertencia', palette.warning)}${swatch('Peligro', palette.danger)}${swatch('Información', palette.info)}
<h3>Contraste verificado (WCAG 2.2 AA)</h3>
<div class="tablewrap"><table><thead><tr><th>Combinación</th><th>Muestra</th><th>Ratio</th><th>Mínimo</th><th>Resultado</th></tr></thead><tbody>${contrastRows}</tbody></table></div>
</section>

<section><h2>2 · Tipografía</h2>${typeRows}</section>

<section><h2>3 · Espaciado, bordes y sombras</h2>
<div class="bars">${Object.entries(spacing).filter(([k]) => +k > 0).map(([k, v]) => `<div><div class="bar" style="width:${v}"></div><small>space-${k} · ${v}</small></div>`).join('')}</div>
<h3>Radios y elevación</h3><div class="grid">${Object.entries(radius).map(([k, v]) => `<div class="card" style="border-radius:${v}">radius-${k}<br><small>${v}</small></div>`).join('')}</div>
<div class="grid" style="margin-top:16px">${['sm', 'md', 'lg'].map((k) => `<div class="card" style="box-shadow:var(--shadow-${k});border-color:var(--border-subtle)">shadow-${k}<br><small>${shadow[k]}</small></div>`).join('')}</div>
</section>

<section><h2>4 · Componentes base</h2>
<h3>Botones</h3><div class="row"><button class="btn btn-primary">Cobrar</button><button class="btn btn-secondary">Reprogramar</button><button class="btn btn-ghost">Ver historial</button><button class="btn btn-danger">Dar de baja</button><button class="btn btn-primary" disabled>Deshabilitado</button><button class="btn btn-secondary btn-sm">Pequeño</button></div>
<h3>Campos</h3><div class="grid">
<div><label for="a">DNI</label><input id="a" class="field" inputmode="numeric" maxlength="8" placeholder="8 dígitos"><div class="hint">Solo números. Se valida al salir del campo.</div></div>
<div><label for="b">Correo</label><input id="b" class="field err" value="ana@correo" aria-invalid="true" aria-describedby="e"><div id="e" class="err-msg"><span aria-hidden="true">✕</span>Escriba un correo completo, por ejemplo ana@correo.pe</div></div></div>
<h3>Estados (siempre icono + texto)</h3>
<p><b>Cita</b><br>${badges(statusMap.cita)}</p><p><b>Pago</b><br>${badges(statusMap.pago)}</p><p><b>Comprobante</b> <small>(estados locales; mapeo con Apiworking/SUNAT por validar)</small><br>${badges(statusMap.comprobante)}</p>
<p><b>Consentimiento / paciente / stock</b><br>${badges(statusMap.consentimiento)} ${badges(statusMap.paciente)} ${badges(statusMap.stock)}</p>
<h3>Alertas</h3>
<div class="alert a-warning"><span aria-hidden="true">!</span><div><b>Posible paciente duplicado</b>Existe una ficha con el mismo nombre y fecha de nacimiento. Revísela antes de continuar.</div></div>
<div class="alert a-danger" role="alert"><span aria-hidden="true">✕</span><div><b>Comprobante rechazado</b>Corrija los datos del cliente y vuelva a enviarlo.</div></div>
<div class="alert a-success"><span aria-hidden="true">✓</span><div><b>Cobro registrado</b>El comprobante se enviará automáticamente.</div></div>
<div class="alert a-info"><span aria-hidden="true">i</span><div><b>Sincronizando con Apiworking</b>Su cobro ya está guardado; el comprobante quedará pendiente si hay un corte.</div></div>
<h3>Tabla</h3><div class="tablewrap"><table><thead><tr><th>Hora</th><th>Paciente</th><th>Servicio</th><th>Odontólogo</th><th>Estado</th></tr></thead><tbody>
<tr><td>09:00</td><td><b>Lucía Demo</b></td><td>Control</td><td>Dr. Ríos</td><td>${badge('confirmado', 'brand')}</td></tr>
<tr><td>09:30</td><td><b>Mateo Demo</b> ${badge('menor_sin_representante', 'warning')}</td><td>Limpieza</td><td>Dra. Soto</td><td>${badge('reservado', 'info')}</td></tr>
<tr><td>10:15</td><td><b>Jorge Demo</b></td><td>Endodoncia</td><td>Dr. Ríos</td><td>${badge('ausente', 'danger')}</td></tr></tbody></table></div>
<h3>Tarjeta y modal (reautenticación / motivo)</h3>
<div class="grid"><div class="card elevated"><h3 style="margin-top:0">Saldo por cobrar</h3><p style="font:700 1.75rem var(--font-display);margin:8px 0">S/ 1,240.50</p><small class="hint">4 pacientes con saldo</small></div>
<div class="card elevated" role="dialog" aria-label="Ejemplo de modal"><h3 style="margin-top:0">Dar de baja el adjunto</h3><p>El archivo se conserva; solo dejará de estar disponible.</p><label for="m">Motivo (obligatorio)</label><input id="m" class="field" placeholder="Ej.: se cargó al paciente equivocado"><div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn btn-secondary">Cancelar</button><button class="btn btn-danger">Dar de baja</button></div></div></div>
<h3>Odontograma (convención provisional; formato MINSA por validar)</h3><p>${odonto}</p>
</section>

<section><h2>5 · Composición del panel</h2>
<div class="app"><aside class="side"><div class="brand" style="margin-bottom:16px">${mark.replace('width="40" height="40"', 'width="32" height="32"')}<b style="font-size:1.1rem">ApiDental</b></div>
<div class="ctx"><small>Clínica · Sede</small><b>Clínica Demo</b> · Sede Demo</div>
<nav class="nav" aria-label="Principal"><a class="on" href="#">▣ Hoy</a><a href="#">▤ Agenda</a><a href="#">☺ Pacientes</a><a href="#">S/ Caja</a><a href="#">▥ Comprobantes</a><a href="#">▦ Inventario</a><a href="#">▧ Reportes</a></nav></aside>
<div class="main"><div class="top"><input class="field" placeholder="Buscar paciente por DNI, nombre o celular  ( / )" aria-label="Buscar paciente"><button class="btn btn-primary">+ Nuevo paciente</button></div>
<div class="card"><div class="row" style="justify-content:space-between"><div><h3 style="margin:0">Lucía Demo Adulta</h3><small class="hint">DNI 90000001 · 38 años · Cel. 900 000 001</small></div><div>${badge('activo', 'success')}${badge('vigente', 'success')}</div></div>
<div class="tabs" role="tablist"><a class="on" role="tab" aria-selected="true" href="#">Resumen</a><a role="tab" href="#">Contacto</a><a role="tab" href="#">Representantes</a><a role="tab" href="#">Consentimientos</a><a role="tab" href="#">Adjuntos</a></div>
<div class="alert a-info" style="margin:0"><span aria-hidden="true">i</span><div>Historia clínica y odontograma estarán disponibles en una próxima versión.</div></div></div></div></div>
</section>
</main></body></html>`;
writeFileSync(join(OUT, 'vista-previa.html'), html);
console.log(`Generados tokens.json, tokens.css y vista-previa.html (${results.length} contrastes verificados)`);
