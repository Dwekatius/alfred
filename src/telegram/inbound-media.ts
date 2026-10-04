/**
 * Inbound Telegram media: validate, download (bounded), register as artifacts,
 * and produce provider-sized image derivatives for the model.
 */
import sharp from "sharp";
import { AppConfig, DataPaths } from "../config.js";
import { Logger } from "../logging.js";
import { ArtifactRegistry } from "../artifacts/registry.js";
import { TelegramClient, TelegramApiError } from "./api.js";
import { findCachedModel } from "../pi/models.js";

export interface InboundImageBlock {
  data: string;
  mimeType: string;
  artifactId: string;
  width?: number;
  height?: number;
}

interface StoredAttachments {
  photos?: Array<{ fileId: string; width?: number; height?: number; fileSize?: number }>;
  documents?: Array<{ fileId: string; fileName?: string; mimeType?: string; fileSize?: number }>;
  mediaGroupId?: string | null;
}

const IMAGE_SIGNATURES: Array<{ mime: string; test: (bytes: Buffer) => boolean }> = [
  { mime: "image/png", test: (bytes) => bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  { mime: "image/jpeg", test: (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: "image/webp", test: (bytes) => bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" },
  { mime: "image/gif", test: (bytes) => bytes.length > 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a") },
  { mime: "image/bmp", test: (bytes) => bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d },
];

export function detectImageMime(bytes: Buffer, declared?: string): string | undefined {
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.test(bytes)) return signature.mime;
  }
  if (declared && declared.startsWith("image/")) return declared;
  return undefined;
}

export interface InboundMediaDeps {
  client: TelegramClient;
  artifacts: ArtifactRegistry;
  config: AppConfig;
  paths: DataPaths;
  logger: Logger;
}

export class InboundMediaLoader {
  constructor(private readonly deps: InboundMediaDeps) {}

  parseAttachments(json: string | null): StoredAttachments {
    if (!json) return {};
    try {
      return JSON.parse(json) as StoredAttachments;
    } catch {
      return {};
    }
  }

  async loadForJob(attachmentsJson: string | null, jobId: string): Promise<InboundImageBlock[]> {
    const attachments = this.parseAttachments(attachmentsJson);
    const blocks: InboundImageBlock[] = [];
    const maxBytes = this.deps.config.artifacts.inboundMaxMiB * 1024 * 1024;
    const photos = [...(attachments.photos ?? [])].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
    const chosen = photos.length > 0 ? [photos[0]!] : [];
    for (const photo of chosen) {
      const block = await this.downloadImage(photo.fileId, jobId, maxBytes, "photo");
      if (block) blocks.push(block);
    }
    for (const document of attachments.documents ?? []) {
      if (!document.mimeType?.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(document.fileName ?? "")) continue;
      const block = await this.downloadImage(document.fileId, jobId, maxBytes, document.fileName ?? "document");
      if (block) blocks.push(block);
    }
    return blocks;
  }

  private async downloadImage(fileId: string, jobId: string, maxBytes: number, label: string): Promise<InboundImageBlock | undefined> {
    const { client, artifacts, logger } = this.deps;
    try {
      const file = await client.getFile(fileId);
      if (file.file_size && file.file_size > maxBytes) {
        logger.warn("media.too_large", "Inbound image exceeds the configured limit; skipped.", { eventCode: "MEDIA_TOO_LARGE", jobId, sizeBytes: file.file_size, maxBytes });
        return undefined;
      }
      const bytes = await client.downloadFile(client.filePathFromFile(file), maxBytes);
      const mime = detectImageMime(bytes, undefined);
      if (!mime) {
        logger.warn("media.rejected", "Inbound file is not a supported image; skipped.", { eventCode: "MEDIA_REJECTED", jobId });
        return undefined;
      }
      const metadata = await sharp(bytes).metadata();
      if ((metadata.width ?? 0) * (metadata.height ?? 0) > 100_000_000) {
        logger.warn("media.dimensions", "Inbound image dimensions are excessive; skipped.", { eventCode: "MEDIA_DIMENSIONS", jobId });
        return undefined;
      }
      const artifact = artifacts.register({ jobId, kind: "inbound_image", mime, filename: label, bytes, width: metadata.width, height: metadata.height });
      const derivative = await this.providerDerivative(bytes, mime);
      return { data: derivative.data.toString("base64"), mimeType: derivative.mime, artifactId: artifact.id, width: metadata.width, height: metadata.height };
    } catch (error) {
      if (error instanceof TelegramApiError) {
        logger.warn("media.download_failed", "Inbound image download failed.", { eventCode: "MEDIA_DOWNLOAD_FAILED", jobId, message: error.message.slice(0, 200) });
        return undefined;
      }
      logger.warn("media.download_failed", "Inbound image processing failed.", { eventCode: "MEDIA_DOWNLOAD_FAILED", jobId, message: (error as Error).message.slice(0, 200) });
      return undefined;
    }
  }

  private async providerDerivative(bytes: Buffer, mime: string): Promise<{ data: Buffer; mime: string }> {
    const slot = this.deps.config.models.slots[this.deps.config.models.selectedSlot] ?? Object.values(this.deps.config.models.slots)[0];
    const metadata = slot ? findCachedModel(this.deps.paths, slot.provider, slot.modelId) : undefined;
    const resize = (metadata?.inputLimits as { images?: { resize?: { maxWidth?: number; maxHeight?: number; maxBytes?: number; jpegQuality?: number } } } | undefined)?.images?.resize ?? {};
    const maxWidth = resize.maxWidth ?? 2000;
    const maxHeight = resize.maxHeight ?? 2000;
    const maxBytes = resize.maxBytes ?? 4_500_000;
    let pipeline = sharp(bytes).rotate();
    const info = await pipeline.metadata();
    if ((info.width ?? 0) > maxWidth || (info.height ?? 0) > maxHeight) {
      pipeline = pipeline.resize({ width: maxWidth, height: maxHeight, fit: "inside", withoutEnlargement: true });
    }
    if (maxBytes > 0 && bytes.byteLength > maxBytes) {
      const quality = resize.jpegQuality ?? 80;
      const jpeg = await pipeline.jpeg({ quality }).toBuffer();
      if (jpeg.byteLength <= maxBytes || mime === "image/jpeg") return { data: jpeg, mime: "image/jpeg" };
      return { data: await sharp(jpeg).resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: Math.max(50, quality - 20) }).toBuffer(), mime: "image/jpeg" };
    }
    if (mime === "image/png" || mime === "image/webp") return { data: await pipeline.png().toBuffer(), mime: "image/png" };
    return { data: await pipeline.jpeg({ quality: resize.jpegQuality ?? 80 }).toBuffer(), mime: "image/jpeg" };
  }
}
