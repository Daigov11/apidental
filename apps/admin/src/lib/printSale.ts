import { get } from '../api/client';
import type { AwSale } from '../api/types';

export type PrintFormat = 'a4' | 'ticket';

export interface SalePrintData {
  sale: AwSale & { discountCents?: number };
  documentLabel: string;
  clinic: { name: string; legalName: string | null; ruc: string | null };
  branch: { name: string; address: string | null } | null;
  cashier: string | null;
  payments: { name: string; amountCents: number }[];
  grossCents: number;
  taxableCents: number;
  igvCents: number;
}

const PREF_KEY = 'apidental.printOnSale';
/** Formato de impresión al cobrar, recordado en este navegador (cada caja tiene su impresora). */
export const readPrintPref = (): PrintFormat | 'none' => {
  try { const v = localStorage.getItem(PREF_KEY); return v === 'a4' || v === 'ticket' ? v : 'none'; } catch { return 'none'; }
};
export const writePrintPref = (v: PrintFormat | 'none') => { try { localStorage.setItem(PREF_KEY, v); } catch { /* sin almacenamiento: no se recuerda */ } };

const esc = (s: string | number | null | undefined) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (c: number) => `S/ ${(c / 100).toFixed(2)}`;
const when = (iso: string) => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/** Documento de la venta en HTML listo para imprimir: A4 (con tabla) o ticket de 80 mm (ticketera térmica). */
export function saleDocumentHtml(d: SalePrintData, format: PrintFormat): string {
  const s = d.sale;
  const number = s.externalNumber ?? 'Sin número';
  const lines = s.lines.map((l) => ({ name: l.name, qty: l.quantity, unit: l.unitPriceCents, total: l.quantity * l.unitPriceCents }));
  const discount = s.discountCents ?? 0;
  const ticket = format === 'ticket';
  const css = ticket
    ? `@page{size:80mm auto;margin:3mm}body{width:74mm;font:12px/1.35 'Courier New',monospace;margin:0;color:#000}
       h1{font-size:14px;text-align:center;margin:0}.c{text-align:center}.r{text-align:right}hr{border:0;border-top:1px dashed #000;margin:6px 0}
       table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:1px 0}.b{font-weight:bold}.small{font-size:10px}`
    : `@page{size:A4;margin:15mm}body{font:12px/1.4 Arial,Helvetica,sans-serif;color:#111;margin:0}
       .head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.box{border:1.5px solid #111;border-radius:6px;padding:10px 16px;text-align:center;min-width:200px}
       h1{font-size:18px;margin:0 0 4px}.box .doc{font-size:13px;font-weight:bold;text-transform:uppercase}.box .num{font-size:16px;font-weight:bold;margin-top:4px}
       table{width:100%;border-collapse:collapse;margin-top:14px}th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left}th{background:#f2f4f6}
       .r{text-align:right}.totals{width:280px;margin-left:auto;margin-top:10px}.totals td{border:0;padding:3px 8px}.b{font-weight:bold}.muted{color:#555}.small{font-size:10px}`;
  const clinicLines = [d.clinic.legalName && d.clinic.legalName !== d.clinic.name ? d.clinic.legalName : '', d.clinic.ruc ? `RUC ${d.clinic.ruc}` : '', d.branch?.address ?? ''].filter(Boolean);
  const totals = [
    discount ? ['Subtotal', money(d.grossCents)] : null,
    discount ? ['Descuento', `- ${money(discount)}`] : null,
    ['Op. gravada', money(d.taxableCents)],
    ['IGV (18%)', money(d.igvCents)],
    ['TOTAL', money(s.totalCents)],
  ].filter((x): x is string[] => x !== null);
  const pays = d.payments.map((p) => `${esc(p.name)} ${money(p.amountCents)}`).join(' · ');
  const notice = s.docStatus === 'SENT'
    ? 'Representación de la venta. La representación impresa oficial del comprobante electrónico es la de Apiworking.'
    : 'Documento interno: el comprobante electrónico aún no está confirmado.';

  const body = ticket
    ? `<h1>${esc(d.clinic.name)}</h1>${clinicLines.map((l) => `<div class="c small">${esc(l)}</div>`).join('')}
       <hr><div class="c b">${esc(d.documentLabel.toUpperCase())}</div><div class="c b">${esc(number)}</div>
       <div class="small">Fecha: ${esc(when(s.createdAt))}</div><div class="small">Cliente: ${esc(s.customer.name)}</div><div class="small">${esc(s.customer.docType)} ${esc(s.customer.docNumber)}</div>
       <hr><table>${lines.map((l) => `<tr><td colspan="2">${esc(l.name)}</td></tr><tr><td class="small">${l.qty} x ${money(l.unit)}</td><td class="r">${money(l.total)}</td></tr>`).join('')}</table>
       <hr><table>${totals.map(([k, v]) => `<tr><td${k === 'TOTAL' ? ' class="b"' : ''}>${esc(k)}</td><td class="r${k === 'TOTAL' ? ' b' : ''}">${esc(v)}</td></tr>`).join('')}</table>
       <hr><div class="small">Pago: ${pays}</div>${d.cashier ? `<div class="small">Atendido por: ${esc(d.cashier)}</div>` : ''}
       <hr><div class="c small">${esc(notice)}</div><div class="c small">¡Gracias por su preferencia!</div>`
    : `<div class="head"><div><h1>${esc(d.clinic.name)}</h1>${clinicLines.map((l) => `<div class="muted">${esc(l)}</div>`).join('')}${d.branch ? `<div class="muted">Sede: ${esc(d.branch.name)}</div>` : ''}</div>
         <div class="box">${d.clinic.ruc ? `<div>RUC ${esc(d.clinic.ruc)}</div>` : ''}<div class="doc">${esc(d.documentLabel)}</div><div class="num">${esc(number)}</div></div></div>
       <table style="margin-top:18px"><tr><td><b>Cliente:</b> ${esc(s.customer.name)}</td><td><b>${esc(s.customer.docType)}:</b> ${esc(s.customer.docNumber)}</td><td><b>Fecha:</b> ${esc(when(s.createdAt))}</td></tr></table>
       <table><thead><tr><th>Descripción</th><th class="r">Cant.</th><th class="r">P. unit.</th><th class="r">Importe</th></tr></thead>
       <tbody>${lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${l.qty}</td><td class="r">${money(l.unit)}</td><td class="r">${money(l.total)}</td></tr>`).join('')}</tbody></table>
       <table class="totals">${totals.map(([k, v]) => `<tr><td${k === 'TOTAL' ? ' class="b"' : ''}>${esc(k)}</td><td class="r${k === 'TOTAL' ? ' b' : ''}">${esc(v)}</td></tr>`).join('')}</table>
       <p><b>Forma de pago:</b> ${pays}${d.cashier ? ` &nbsp; <b>Atendido por:</b> ${esc(d.cashier)}` : ''}</p>
       <p class="small muted">${esc(notice)}</p>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(d.documentLabel)} ${esc(number)}</title><style>${css}</style></head><body>${body}</body></html>`;
}

/** Imprime HTML con un iframe oculto (no lo bloquea el navegador como ventana emergente, aunque sea después de cobrar). */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  const go = () => {
    try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } finally { setTimeout(() => frame.remove(), 60_000); }
  };
  if (doc.readyState === 'complete') setTimeout(go, 50);
  else frame.addEventListener('load', go, { once: true });
}

/** Trae los datos de la venta y la imprime en el formato pedido. */
export async function printSale(saleId: string, format: PrintFormat): Promise<void> {
  const data = await get<SalePrintData>(`/apiworking/sales/${saleId}/print`);
  printHtml(saleDocumentHtml(data, format));
}

/** Abre el PDF oficial del comprobante de Apiworking (con QR) en otra pestaña. Se llama desde un clic. */
export async function openOfficialPdf(saleId: string): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.opener = null;
  try {
    const { url } = await get<{ url: string }>(`/apiworking/sales/${saleId}/official-url`);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
  } catch (e) {
    tab?.close();
    throw e;
  }
}
