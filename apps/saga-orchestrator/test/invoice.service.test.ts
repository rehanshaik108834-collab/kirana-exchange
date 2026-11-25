import { describe, expect, it } from 'vitest';
import { DEFAULT_TAX_DISCLAIMER, SwapTransaction } from '../src/entities/swap-transaction.entity';
import { buildInvoiceNumber, InvoiceService } from '../src/invoice.service';

describe('InvoiceService — GST-compliant Swap Invoice PDF & QR Code', () => {
  it('generates a valid PDF binary with invoice metadata, GST disclaimer, and QR payload', async () => {
    const tx = Object.assign(new SwapTransaction(), {
      id: '11111111-1111-4111-8111-111111111111',
      offerId: '22222222-2222-4222-8222-222222222222',
      listingId: '33333333-3333-4333-8333-333333333333',
      sellerShopId: '44444444-4444-4444-8444-444444444444',
      buyerShopId: '55555555-5555-4555-8555-555555555555',
      batchId: '66666666-6666-4666-8666-666666666666',
      productId: '77777777-7777-4777-8777-777777777777',
      shopState: 'Telangana',
      qty: 12,
      price: '42.50',
      costPrice: '50.00',
      expiryDate: '2026-07-15',
      state: 'COMPLETED',
      billRecordId: '88888888-8888-4888-8888-888888888888',
      taxDisclaimer: DEFAULT_TAX_DISCLAIMER,
      updatedAt: new Date('2026-04-01T10:30:00Z'),
    });

    const service = new InvoiceService();
    const invoice = await service.generateSwapInvoicePdf(tx);

    expect(invoice.invoiceNo).toBe(buildInvoiceNumber(tx));
    expect(invoice.invoiceNo).toMatch(/^KX-SWAP-8888888888$/);
    expect(invoice.filename).toBe(`${invoice.invoiceNo}.pdf`);
    expect(invoice.contentType).toBe('application/pdf');
    expect(invoice.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(invoice.buffer.length).toBeGreaterThan(1500);

    const parsedQr = JSON.parse(invoice.qrPayload);
    expect(parsedQr).toMatchObject({
      invoiceNo: invoice.invoiceNo,
      billRecordId: tx.billRecordId,
      transactionId: tx.id,
      state: 'Telangana',
      qty: 12,
      unitPriceInr: 42.5,
      totalValueInr: 510,
      expiryDate: '2026-07-15',
    });
  });
});
