import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import pino from 'pino';

type MailTransporter = ReturnType<typeof nodemailer.createTransport>;

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSendResult {
  sent: boolean;
  messageId?: string;
}

@Injectable()
export class MailerService {
  private readonly logger = pino({ name: 'notification-mailer' });
  private readonly fromAddress = process.env.SMTP_FROM || 'alerts@kirana.exchange';
  private readonly enabled = process.env.SMTP_ENABLED !== 'false';
  private transporter: MailTransporter | null = null;

  private getTransporter(): MailTransporter {
    if (!this.transporter) {
      const host = process.env.SMTP_HOST || '127.0.0.1';
      const port = Number(process.env.SMTP_PORT || 1025);
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;

      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        ...(user && pass ? { auth: { user, pass } } : {}),
      });
    }
    return this.transporter;
  }

  async sendEmail(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.enabled) {
      return { sent: false };
    }

    try {
      const info = await this.getTransporter().sendMail({
        from: this.fromAddress,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      this.logger.info({ to: message.to, subject: message.subject }, 'SMTP alert email delivered');
      return { sent: true, messageId: info.messageId };
    } catch (err) {
      this.logger.warn(
        { to: message.to, subject: message.subject, err: (err as Error).message },
        'SMTP delivery failed; in-app notification remains persisted',
      );
      return { sent: false };
    }
  }
}
