/** Decouples job handlers from grammY so they stay unit-testable. */
export interface SendOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
  replyMarkup?: unknown;
}

export interface Notifier {
  send(chatId: number, text: string, opts?: SendOptions): Promise<number | null>;
  edit(chatId: number, messageId: number, text: string, opts?: SendOptions): Promise<boolean>;
  sendDocument?(chatId: number, filePath: string, caption?: string): Promise<boolean>;
}

export class NullNotifier implements Notifier {
  readonly messages: Array<{ chatId: number; text: string }> = [];
  async send(chatId: number, text: string): Promise<number | null> {
    this.messages.push({ chatId, text });
    return this.messages.length;
  }
  async edit(): Promise<boolean> {
    return true;
  }
}
