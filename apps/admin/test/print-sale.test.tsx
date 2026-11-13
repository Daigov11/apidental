import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach } from 'vitest';
import { saleDocumentHtml, type SalePrintData } from '../src/lib/printSale';
import { mockApi, renderApp, sessionRoutes } from './helpers';

const SALE = {
  id: 's-1', description: 'Curaciones', customerId: '1', contingency: false, appointmentId: null, patientId: null,
  customer: { name: 'MARCO <CUENTA>', docType: 'DNI', docNumber: '45678912' }, totalCents: 22500, totalText: 'S/ 225.00', discountCents: 2500,
  lines: [{ name: 'Curación (piezas 16, 26)', quantity: 2, unitPriceCents: 10000 }, { name: 'Amoxicilina 500 mg', quantity: 1, unitPriceCents: 5000 }],
  docDate: '2026-11-13', serie: 'B001', docStatus: 'SENT', docStatusLabel: 'Registrado en Apiworking', paymentStatus: 'CONFIRMED_REMOTE', paymentStatusLabel: 'Pagado',
  voidStatus: null, voidStatusLabel: null, externalDocId: '22600001578', externalNumber: 'B001-1423', failureReason: null, attemptedAt: null, createdAt: '2026-11-13T15:00:00.000Z',
  actions: { issue: false, verify: false, reconcile: false, pay: false, void: false },
};
const DATA: SalePrintData = {
  sale: SALE as never, documentLabel: 'Boleta de venta electrónica',
  clinic: { name: 'Dental Glow', legalName: 'GLOW SMILE S.A.C.', ruc: '20123456789' }, branch: { name: 'Sede principal', address: 'Av. Lima 123' },
  cashier: 'Rosa Caja', payments: [{ name: 'Efectivo', amountCents: 12500 }, { name: 'Yape', amountCents: 10000 }],
  grossCents: 25000, taxableCents: 19068, igvCents: 3432,
};

describe('documento de venta para imprimir', () => {
  it('ticket de 80 mm: encabezado, número, líneas, descuento, IGV, total y pagos; el texto se escapa', () => {
    const html = saleDocumentHtml(DATA, 'ticket');
    expect(html).toContain('size:80mm auto');
    for (const t of ['Dental Glow', 'RUC 20123456789', 'BOLETA DE VENTA ELECTRÓNICA', 'B001-1423', 'Curación (piezas 16, 26)', '2 x S/ 100.00', 'S/ 200.00', 'Descuento', '- S/ 25.00', 'IGV (18%)', 'S/ 34.32', 'S/ 225.00', 'Efectivo S/ 125.00 · Yape S/ 100.00', 'Rosa Caja']) expect(html).toContain(t);
    expect(html).toContain('MARCO &lt;CUENTA&gt;');
    expect(html).not.toContain('MARCO <CUENTA>');
  });
  it('A4: hoja A4 con tabla y el aviso de que el oficial es el de Apiworking', () => {
    const html = saleDocumentHtml(DATA, 'a4');
    expect(html).toContain('size:A4');
    expect(html).toContain('<th class="r">P. unit.</th>');
    expect(html).toContain('La representación impresa oficial del comprobante electrónico es la de Apiworking');
  });
});

describe('impresión al cobrar', () => {
  beforeEach(() => { try { localStorage.setItem('apidental.printOnSale', 'ticket'); } catch { /* sin almacenamiento */ } });
  afterEach(() => { try { localStorage.removeItem('apidental.printOnSale'); } catch { /* sin almacenamiento */ } vi.unstubAllGlobals(); });

  it('con «Ticket» elegido, al cobrar pide los datos de la venta e imprime; luego se puede reimprimir en A4', async () => {
    const CUSTOMER = { id: '202600000038', personId: '1', name: 'ROBERTO CARLOS ESPINAR VICHARRA', email: '', docType: 'D.N.I.', docNumber: '74908568', phone: '', whatsapp: '', personType: 'N', active: true };
    const { called } = mockApi({
      ...sessionRoutes(['apiworking:read', 'apiworking:sell', 'branch:read', 'clinic:read'], ['CASHIER']),
      'GET /appointments': { json: [] },
      'GET /integrations/status': { json: { mode: 'off', simulation: null } },
      'GET /auth/config': { json: { mode: 'apiworking' } },
      'GET /apiworking/status': { json: { configured: true, read: true, write: true, tenant: 't', session: true } },
      'GET /apiworking/sales': { json: { items: [], total: 0 } },
      'GET /apiworking/clients': { json: { items: [CUSTOMER], total: 1 } },
      'GET /apiworking/sales/context': { json: { cajas: [{ id: '5', name: 'Caja', branch: '' }], authorizedConfigured: false, opened: true, documentTypes: [{ id: '2', name: 'Boleta' }], series: [{ id: '11', serie: 'B001' }], paymentMethods: [{ id: '1', name: 'Efectivo' }] } },
      'GET /products': { json: [] },
      'POST /apiworking/sales': { status: 201, json: SALE },
      'GET /apiworking/sales/s-1/print': { json: DATA },
    } as never);
    renderApp('/ventas');
    const user = userEvent.setup();
    expect(await screen.findByLabelText('Imprimir al cobrar')).toHaveValue('ticket');
    await user.type(screen.getByLabelText('Buscar cliente'), 'robert');
    await user.click(await screen.findByRole('button', { name: /ROBERTO CARLOS/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Efectivo' })).toHaveAttribute('aria-pressed', 'true'));
    await user.type(screen.getByLabelText('Concepto 1'), 'Curación');
    await user.type(screen.getByLabelText(/Precio unitario/), '225');
    await user.click(screen.getByRole('button', { name: 'Cobrar S/ 225.00' }));
    await waitFor(() => expect(called('GET', '/apiworking/sales/s-1/print')).toHaveLength(1));
    // Se imprimió desde un iframe oculto con el ticket.
    await waitFor(() => expect(document.querySelector('iframe[aria-hidden="true"]')).not.toBeNull());
    expect(await screen.findByRole('heading', { name: 'Última venta · B001-1423' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Imprimir A4' }));
    await waitFor(() => expect(called('GET', '/apiworking/sales/s-1/print')).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Comprobante oficial (PDF)' })).toBeInTheDocument();
  });
});
