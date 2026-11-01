import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';

const MODEL = 'claude-opus-5-5';
const MAX_IMAGES = 5;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type AllowedMime = (typeof ALLOWED_MIME)[number];

const MSG_NOT_CONFIGURED = 'AI xizmati sozlanmagan. Administrator ANTHROPIC_API_KEY ni qo‘shishi kerak.';
const MSG_REFUSED = 'AI bu rasmlarni tahlil qila olmadi. Boshqa rasm yuboring.';
const MSG_UNAVAILABLE = 'AI xizmati vaqtincha javob bermayapti. Birozdan keyin qayta urinib ko‘ring.';

const UNITS = ['PIECE', 'KG', 'LITER', 'BOX', 'METER'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;

const DraftSchema = z.object({
  drafts: z.array(
    z.object({
      name: z.string(),
      description: z.string().nullable(),
      unit: z.enum(UNITS),
      salePrice: z.string().nullable(),
      barcode: z.string().nullable(),
      categoryId: z.string().nullable(),
      newCategoryName: z.string().nullable(),
      confidence: z.enum(CONFIDENCES),
      imageIndexes: z.array(z.number()),
      notes: z.string().nullable(),
    }),
  ),
});

export interface ProductDraft {
  name: string;
  description: string | null;
  unit: (typeof UNITS)[number];
  salePrice: string | null;
  barcode: string | null;
  categoryId: string | null;
  newCategoryName: string | null;
  confidence: (typeof CONFIDENCES)[number];
  imageIndexes: number[];
  notes: string | null;
}

export interface AiDraftResult {
  drafts: ProductDraft[];
  model: string;
}

const SYSTEM_PROMPT = `You are a product-catalog assistant for a small retail shop in Uzbekistan. The user sends 1-5 photos of products (shelves, packages, price tags). Produce draft catalog entries.

Rules:
- Identify each distinct sellable product across ALL photos. If the same product appears in several photos, return ONE draft and list every photo index (0-based, in the order sent) in imageIndexes.
- name: brand + product type + size/weight exactly as printed (e.g. "Coca-Cola 1.5 l"). Keep brand names as printed. Max 200 characters.
- All text you write (name, description, notes, newCategoryName) must be in Uzbek, Latin script, using the apostrophes ‘ and ’ (o‘, g‘, ma’lumot). description: short, at most 200 characters, or null.
- unit: PIECE for packaged goods; KG for loose/weighed goods; LITER only for loose liquids sold by volume; BOX for multi-packs sold as a box; METER only for goods sold by length.
- NEVER guess prices or barcodes. salePrice only if a price tag is clearly legible: digits only in Uzbek so‘m, e.g. "12500" or "12500.00". barcode only if all digits (8-14) are clearly legible. Otherwise null.
- categoryId: pick the id of the best matching category from the provided list. If none fits, set categoryId to null and propose newCategoryName (a short Uzbek name). Never set both.
- confidence (high/medium/low) reflects how certain you are about the identification.
- notes: mention what the user should double-check (e.g. unreadable size), or null.
- If no products are visible, return an empty drafts list.`;

@Injectable()
export class AiDraftService {
  private readonly logger = new Logger(AiDraftService.name);
  private client: Anthropic | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async draft(user: AuthUser, files: Express.Multer.File[] | undefined): Promise<AiDraftResult> {
    if (!files || files.length === 0) throw new BadRequestException('Kamida 1 ta rasm yuboring');
    if (files.length > MAX_IMAGES) throw new BadRequestException(`Ko‘pi bilan ${MAX_IMAGES} ta rasm yuborish mumkin`);
    for (const f of files) {
      if (!(ALLOWED_MIME as readonly string[]).includes(f.mimetype)) {
        throw new BadRequestException('Rasm turi noto‘g‘ri. Faqat JPEG, PNG, WebP yoki GIF qabul qilinadi');
      }
      if (f.size > 5 * 1024 * 1024) throw new BadRequestException('Rasm hajmi 5 MB dan oshmasligi kerak');
    }

    const isProd = process.env.NODE_ENV === 'production';
    if (process.env.AI_PRODUCT_DRAFT_MOCK === '1' && !isProd) {
      await new Promise((r) => setTimeout(r, 1500));
      return { drafts: this.mockDrafts(files.length), model: MODEL };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) throw new ServiceUnavailableException(MSG_NOT_CONFIGURED);

    const categories = await this.prisma.category.findMany({
      where: { storeId: user.storeId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    this.client ??= new Anthropic({ apiKey });

    const content: Anthropic.ContentBlockParam[] = files.map((f) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: f.mimetype as AllowedMime, data: f.buffer.toString('base64') },
    }));
    content.push({
      type: 'text',
      text:
        `Photos sent: ${files.length} (indexes 0..${files.length - 1}).\n` +
        `Existing categories (JSON): ${JSON.stringify(categories)}\n` +
        'Return the product drafts.',
    });

    let parsed: z.infer<typeof DraftSchema> | null;
    try {
      const response = await this.client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'medium', format: zodOutputFormat(DraftSchema) },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      });
      if (response.stop_reason === 'refusal') throw new UnprocessableEntityException(MSG_REFUSED);
      parsed = response.parsed_output;
    } catch (e) {
      if (e instanceof UnprocessableEntityException) throw e;
      if (e instanceof Anthropic.AuthenticationError) {
        this.logger.error(`Anthropic autentifikatsiya xatosi (${e.status}): ${e.message}`);
        throw new ServiceUnavailableException(MSG_NOT_CONFIGURED);
      }
      if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIError) {
        this.logger.error(`Anthropic xatosi: ${e.constructor.name}: ${e.message}`);
        throw new BadGatewayException(MSG_UNAVAILABLE);
      }
      this.logger.error(`AI qoralama kutilmagan xato: ${e instanceof Error ? e.message : String(e)}`);
      throw new BadGatewayException(MSG_UNAVAILABLE);
    }

    if (!parsed) {
      this.logger.error('Anthropic javobi parse qilinmadi (parsed_output null)');
      throw new BadGatewayException(MSG_UNAVAILABLE);
    }

    return { drafts: this.normalize(parsed.drafts, categories, files.length), model: MODEL };
  }

  private normalize(
    raw: z.infer<typeof DraftSchema>['drafts'],
    categories: { id: string; name: string }[],
    imageCount: number,
  ): ProductDraft[] {
    const ids = new Set(categories.map((c) => c.id));
    const out: ProductDraft[] = [];
    for (const d of raw) {
      const name = d.name.trim().slice(0, 200);
      if (!name) continue;

      let salePrice: string | null = null;
      const price = d.salePrice?.trim().replace(/\s/g, '') ?? '';
      if (/^\d+(\.\d{1,2})?$/.test(price)) salePrice = Number(price).toFixed(2);

      const bc = d.barcode?.trim() ?? '';
      const barcode = /^\d{8,14}$/.test(bc) ? bc : null;

      const categoryId = d.categoryId && ids.has(d.categoryId) ? d.categoryId : null;
      const newCategoryName = categoryId ? null : d.newCategoryName?.trim().slice(0, 100) || null;

      const imageIndexes = [
        ...new Set(d.imageIndexes.map((n) => Math.trunc(n)).filter((n) => n >= 0 && n < imageCount)),
      ].sort((a, b) => a - b);

      out.push({
        name,
        description: d.description?.trim().slice(0, 200) || null,
        unit: d.unit,
        salePrice,
        barcode,
        categoryId,
        newCategoryName,
        confidence: d.confidence,
        imageIndexes,
        notes: d.notes?.trim() || null,
      });
    }
    return out;
  }

  private mockDrafts(imageCount: number): ProductDraft[] {
    return [
      {
        name: 'Coca-Cola 1.5 l',
        description: 'Gazlangan ichimlik, plastik shisha',
        unit: 'PIECE',
        salePrice: null,
        barcode: null,
        categoryId: null,
        newCategoryName: 'Ichimliklar',
        confidence: 'high',
        imageIndexes: [0],
        notes: 'Narx yorlig‘i ko‘rinmadi — narxni o‘zingiz kiriting',
      },
      {
        name: 'Lays chips 90 g',
        description: 'Kartoshka chipsi, smetana va ko‘kat ta’mi',
        unit: 'PIECE',
        salePrice: '14000.00',
        barcode: null,
        categoryId: null,
        newCategoryName: 'Gazaklar',
        confidence: 'medium',
        imageIndexes: [Math.min(1, imageCount - 1)],
        notes: 'Narx yorlig‘idan o‘qildi',
      },
    ];
  }
}
