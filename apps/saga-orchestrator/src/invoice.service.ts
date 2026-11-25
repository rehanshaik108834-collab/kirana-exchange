import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { toBuffer as qrToBuffer } from 'qrcode';
import { DEFAULT_TAX_DISCLAIMER, type SwapTransaction } from './entities/swap-transaction.entity';

export interface GeneratedSwapInvoice {
  invoiceNo: string;
  filename: string;
  contentType: 'application/pdf';
  qrPayload: string;
  buffer: Buffer;
}

export function buildInvoiceNumber(tx: SwapTransaction): string {
  const shortId = (tx.billRecordId ?? tx.id).replace(/-/g, '').slice(0, 10).toUpperCase();
  return `KX-SWAP-${shortId}`;
}

@Injectable()
export class InvoiceService {
  /**
   * Generates a GST-compliant Intra-State Peer Swap Transfer Bill PDF with an embedded
   * verification QR code and mandatory intra-state peer sale tax disclaimer.
   */
  async generateSwapInvoicePdf(tx: SwapTransaction): Promise<GeneratedSwapInvoice> {
    const invoiceNo = buildInvoiceNumber(tx);
    const unitPrice = Number(tx.price);
    const totalValue = Number((unitPrice * tx.qty).toFixed(2));
    const issuedAt = (tx.updatedAt ?? new Date()).toISOString();

    const qrPayload = JSON.stringify({
      invoiceNo,
      billRecordId: tx.billRecordId ?? tx.id,
      transactionId: tx.id,
      state: tx.shopState,
      sellerShopId: tx.sellerShopId,
      buyerShopId: tx.buyerShopId,
      productId: tx.productId,
      batchId: tx.batchId,
      qty: tx.qty,
      unitPriceInr: unitPrice,
      totalValueInr: totalValue,
      expiryDate: tx.expiryDate,
      issuedAt,
    });

    const qrPngBuffer = await qrToBuffer(qrPayload, {
      type: 'png',
      width: 140,
      margin: 1,
      errorCorrectionLevel: 'M',
    });

    const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      doc.fontSize(18).font('Helvetica-Bold').text('KIRANA EXCHANGE', { align: 'left' });
      doc
        .fontSize(11)
        .font('Helvetica')
        .fillColor('#334155')
        .text('Intra-State Peer Surplus Swap Transfer Bill', { align: 'left' });
      doc.moveDown(0.5);

      doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor('#cbd5e1').stroke();
      doc.moveDown(0.8);

      // Invoice metadata
      doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold');
      doc.text(`Invoice Number: `, { continued: true }).font('Helvetica').text(invoiceNo);
      doc
        .font('Helvetica-Bold')
        .text(`Bill Record ID: `, { continued: true })
        .font('Helvetica')
        .text(tx.billRecordId ?? tx.id);
      doc
        .font('Helvetica-Bold')
        .text(`Swap Transaction ID: `, { continued: true })
        .font('Helvetica')
        .text(tx.id);
      doc
        .font('Helvetica-Bold')
        .text(`Intra-State Jurisdiction: `, { continued: true })
        .font('Helvetica')
        .text(tx.shopState);
      doc
        .font('Helvetica-Bold')
        .text(`Issued At (UTC): `, { continued: true })
        .font('Helvetica')
        .text(issuedAt);

      doc.moveDown(1);

      // Parties
      doc.font('Helvetica-Bold').fontSize(11).text('Transfer Participants');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Seller Shop ID: ${tx.sellerShopId}`);
      doc.text(`Buyer Shop ID:  ${tx.buyerShopId}`);
      doc.moveDown(1);

      // Line Item Details
      doc.font('Helvetica-Bold').fontSize(11).text('Transferred Stock Batch Details');
      doc.font('Helvetica').fontSize(10);
      doc.text(`Product ID:            ${tx.productId}`);
      doc.text(`Source Batch ID:       ${tx.batchId}`);
      doc.text(`Preserved Expiry Date: ${tx.expiryDate}`);
      doc.text(`Preserved Cost Price:  INR ${Number(tx.costPrice).toFixed(2)} / unit`);
      doc.text(`Quantity Transferred:  ${tx.qty} units`);
      doc.text(`Agreed Transfer Price: INR ${unitPrice.toFixed(2)} / unit`);
      doc.moveDown(0.5);

      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(`Total Transfer Value:  INR ${totalValue.toFixed(2)}`);

      doc.moveDown(1.2);

      // QR Code Block
      const qrY = doc.y;
      doc.image(qrPngBuffer, 48, qrY, { width: 120, height: 120 });
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text('Verification QR Code', 185, qrY + 12);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#475569')
        .text(
          'Scan to verify transaction ID, batch expiry provenance, and intra-state transfer totals against Kirana Exchange saga records.',
          185,
          qrY + 30,
          { width: 340 },
        );

      doc.y = qrY + 135;
      doc.moveDown(1);

      // Statutory GST disclaimer
      doc.moveTo(48, doc.y).lineTo(547, doc.y).strokeColor('#cbd5e1').stroke();
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f172a').text('GST & Tax Notice');
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#334155')
        .text(tx.taxDisclaimer || DEFAULT_TAX_DISCLAIMER, { width: 499 });

      doc.end();
    });

    return {
      invoiceNo,
      filename: `${invoiceNo}.pdf`,
      contentType: 'application/pdf',
      qrPayload,
      buffer: pdfBuffer,
    };
  }
}
