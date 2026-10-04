/**
 * Minimal Telegram Bot API client over HTTPS long polling.
 *
 * - Only the methods this product needs.
 * - Timeouts on every request; callers handle retry policy.
 * - Never logs the token, full request URLs, or file-download URLs.
 */
import { Logger } from "../logging.js";

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  media_group_id?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgMe {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
}

export interface TgWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TgMessageId {
  message_id: number;
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly errorCode: number | undefined;
  readonly description: string;
  readonly retryAfter: number | undefined;
  constructor(status: number, description: string, errorCode?: number, retryAfter?: number) {
    super(`Telegram API error ${status}: ${description}`);
    this.name = "TelegramApiError";
    this.status = status;
    this.description = description;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
  }
}

export class TelegramRateLimitError extends TelegramApiError {
  declare readonly retryAfter: number;
  constructor(description: string, retryAfter: number) {
    super(429, description, 429, retryAfter);
    this.name = "TelegramRateLimitError";
  }
}

export class TelegramAuthError extends TelegramApiError {
  constructor(description: string) {
    super(401, description, 401);
    this.name = "TelegramAuthError";
  }
}

export class TelegramConflictError extends TelegramApiError {
  constructor(description: string) {
    super(409, description, 409);
    this.name = "TelegramConflictError";
  }
}

export class TelegramNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramNetworkError";
  }
}

export type TgFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramClientOptions {
  fetchImpl?: TgFetch;
  logger?: Logger;
  baseUrl?: string;
}

export class TelegramClient {
  private readonly fetchImpl: TgFetch;
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;

  constructor(readonly token: string, options: TelegramClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
    this.logger = options.logger;
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private async parseResponse<T>(method: string, response: Response): Promise<T> {
    let body: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new TelegramApiError(response.status, `Non-JSON response from ${method}`);
    }
    if (body.ok) return body.result as T;
    const description = body.description ?? `HTTP ${response.status}`;
    if (response.status === 429 || body.error_code === 429) {
      throw new TelegramRateLimitError(description, body.parameters?.retry_after ?? 1);
    }
    if (response.status === 401 || body.error_code === 401) {
      throw new TelegramAuthError(description);
    }
    if (response.status === 409 || body.error_code === 409) {
      throw new TelegramConflictError(description);
    }
    throw new TelegramApiError(response.status || body.error_code || 0, description, body.error_code, body.parameters?.retry_after);
  }

  private async callJson<T>(method: string, params: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 20000;
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      throw new TelegramNetworkError(`${method} network failure: ${(error as Error).message}`);
    }
    return await this.parseResponse<T>(method, response);
  }

  private async callMultipart<T>(
    method: string,
    fields: Record<string, string | number | undefined>,
    file: { field: string; filename: string; bytes: Buffer; mime: string },
    options: { timeoutMs?: number; signal?: AbortSignal; captionField?: string } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 120000;
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      form.append(key, String(value));
    }
    const blob = new Blob([new Uint8Array(file.bytes)], { type: file.mime });
    form.append(file.field, blob, file.filename);
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(method), { method: "POST", body: form, signal: AbortSignal.any(signals) });
    } catch (error) {
      throw new TelegramNetworkError(`${method} network failure: ${(error as Error).message}`);
    }
    return await this.parseResponse<T>(method, response);
  }

  async getMe(): Promise<TgMe> {
    return await this.callJson<TgMe>("getMe", {}, { timeoutMs: 15000 });
  }

  async getWebhookInfo(): Promise<TgWebhookInfo> {
    return await this.callJson<TgWebhookInfo>("getWebhookInfo", {}, { timeoutMs: 15000 });
  }

  /** Explicitly remove a webhook after the local operator confirmed it. */
  async deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return await this.callJson<boolean>("deleteWebhook", { drop_pending_updates: dropPendingUpdates });
  }

  async getUpdates(offset: number | undefined, timeoutSeconds: number, allowedUpdates: string[], signal?: AbortSignal): Promise<TgUpdate[]> {
    const params: Record<string, unknown> = { timeout: timeoutSeconds, allowed_updates: allowedUpdates };
    if (offset !== undefined) params.offset = offset;
    return await this.callJson<TgUpdate[]>("getUpdates", params, { timeoutMs: (timeoutSeconds + 15) * 1000, signal });
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return await this.callJson<boolean>("setMyCommands", { commands });
  }

  async sendMessage(chatId: string, text: string, options: { replyToMessageId?: number; disableNotification?: boolean; signal?: AbortSignal } = {}): Promise<TgMessageId> {
    return await this.callJson<TgMessageId>(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        ...(options.replyToMessageId ? { reply_to_message_id: options.replyToMessageId } : {}),
        ...(options.disableNotification ? { disable_notification: true } : {}),
      },
      { signal: options.signal },
    );
  }

  async editMessageText(chatId: string, messageId: number, text: string): Promise<TgMessageId | boolean> {
    return await this.callJson<TgMessageId | boolean>("editMessageText", { chat_id: chatId, message_id: messageId, text });
  }

  async sendChatAction(chatId: string, action: "typing" | "upload_photo" | "upload_document" | "choose_sticker"): Promise<boolean> {
    return await this.callJson<boolean>("sendChatAction", { chat_id: chatId, action }, { timeoutMs: 10000 });
  }

  async sendPhoto(chatId: string, bytes: Buffer, filename: string, options: { caption?: string; mime?: string; replyToMessageId?: number; signal?: AbortSignal } = {}): Promise<TgMessageId> {
    return await this.callMultipart<TgMessageId>(
      "sendPhoto",
      { chat_id: chatId, caption: options.caption, reply_to_message_id: options.replyToMessageId },
      { field: "photo", filename, bytes, mime: options.mime ?? "image/png" },
      { signal: options.signal },
    );
  }

  async sendDocument(chatId: string, bytes: Buffer, filename: string, options: { caption?: string; mime?: string; replyToMessageId?: number; signal?: AbortSignal } = {}): Promise<TgMessageId> {
    return await this.callMultipart<TgMessageId>(
      "sendDocument",
      { chat_id: chatId, caption: options.caption, reply_to_message_id: options.replyToMessageId },
      { field: "document", filename, bytes, mime: options.mime ?? "application/octet-stream" },
      { signal: options.signal },
    );
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    return await this.callJson<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert }, { timeoutMs: 10000 });
  }

  async getFile(fileId: string): Promise<TgFile> {
    return await this.callJson<TgFile>("getFile", { file_id: fileId }, { timeoutMs: 20000 });
  }

  /** Download a file by its file_path. The URL contains the token; never log it. */
  async downloadFile(filePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const url = `${this.baseUrl}/file/bot${this.token}/${filePath}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: signal ? AbortSignal.any([AbortSignal.timeout(120000), signal]) : AbortSignal.timeout(120000) });
    } catch (error) {
      throw new TelegramNetworkError(`file download network failure: ${(error as Error).message}`);
    }
    if (!response.ok) throw new TelegramApiError(response.status, `File download failed with HTTP ${response.status}`);
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader && Number.parseInt(lengthHeader, 10) > maxBytes) {
      throw new TelegramApiError(413, `File is larger than the configured inbound limit (${maxBytes} bytes)`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new TelegramApiError(413, `File is larger than the configured inbound limit (${maxBytes} bytes)`);
    return buffer;
  }

  /** Build a Bot API file download path without ever logging it. */
  filePathFromFile(file: TgFile): string {
    if (!file.file_path) throw new TelegramApiError(400, "getFile did not return file_path");
    return file.file_path;
  }
}
