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
import { ApiError as GeminiApiError, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth/auth-user.js';

/**
 * AI provayderi `.env` orqali tanlanadi:
 *   AI_PROVIDER=gemini | openrouter | claude, yoki zanjir: "gemini,openrouter" (birinchisi ishlamasa — keyingisi).
 *   Bo‘sh bo‘lsa — kaliti bor hammasi shu tartibda: gemini → openrouter → claude.
 *   *_MODEL ham vergul bilan bir nechta bo‘lishi mumkin: "model-a,model-b" — navbat bilan sinab ko‘riladi.
 *   GEMINI_API_KEY,     GEMINI_MODEL     (standart: gemini-3.5-flash)
 *   OPENROUTER_API_KEY, OPENROUTER_MODEL (majburiy: rasm + structured outputs qo‘llaydigan model, masalan google/... yoki anthropic/...)
 *   ANTHROPIC_API_KEY,  ANTHROPIC_MODEL  (standart: claude-opus-5-5)
 */
type Provider = 'gemini' | 'openrouter' | 'claude';

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 90_000;

const MAX_IMAGES = 5;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
type AllowedMime = (typeof ALLOWED_MIME)[number];

const MSG_NOT_CONFIGURED =
  'AI xizmati sozlanmagan. Administrator .env faylida GEMINI_API_KEY, OPENROUTER_API_KEY yoki ANTHROPIC_API_KEY ni qo‘shishi kerak.';
const MSG_KEY_REJECTED = 'AI kaliti noto‘g‘ri yoki hisobda mablag‘ yo‘q. Administrator .env dagi kalitni tekshirsin.';
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
      costPrice: z.string().nullable(),
      initialQty: z.string().nullable(),
      barcode: z.string().nullable(),
      categoryId: z.string().nullable(),
      newCategoryName: z.string().nullable(),
      confidence: z.enum(CONFIDENCES),
      imageIndexes: z.array(z.number()),
      notes: z.string().nullable(),
    }),
  ),
});
type DraftOutput = z.infer<typeof DraftSchema>;

/** Gemini/OpenRouter uchun oddiy JSON Schema (zod’dan). `$schema` kaliti olib tashlanadi. */
const DRAFT_JSON_SCHEMA = (() => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(DraftSchema) as Record<string, unknown>;
  return rest;
})();

export interface ProductDraft {
  name: string;
  description: string | null;
  unit: (typeof UNITS)[number];
  salePrice: string | null;
  costPrice: string | null;
  initialQty: string | null;
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

const SYSTEM_PROMPT = `You turn photos of a shop's PRODUCT LIST into catalog entries. The shop is in Uzbekistan.
The user photographs a list written on paper: a notebook page, a handwritten or printed list ("spiska"), an invoice or a supplier price list. It may be in Uzbek (Latin or Cyrillic), Russian or mixed, with abbreviations and crossed-out text. A long list can span several photos. Rarely the photo shows product packages or price tags instead — then make one entry per product.

How to read the list:
- Every row (line) that names a product is ONE entry. Read every row top to bottom, in order; do not skip, merge or invent rows. Skip titles, dates, totals ("jami", "итого", "сумма"), signatures and crossed-out rows.
- If a header row names the columns, map each column by its header (any spelling or language): "nomi / nomlanishi / mahsulot / tovar / наименование / товар / name" -> name; "narxi / sotuv narxi / sotish / цена / розница / price" -> salePrice; "tannarx / kelish narxi / olish narxi / xarid / себестоимость / закуп / опт / cost" -> costPrice; "soni / miqdori / qoldiq / dona / кол-во / количество / qty" -> initialQty; "shtrix / kod / штрихкод / barcode" -> barcode; "birlik / o‘lchov / ед. / unit" -> unit. Ignore columns you cannot map (row numbers, row sums, dates).
- If there is NO header: a row with a name and one number = name + salePrice. With two numbers, use the pattern of the whole list: a small integer next to "ta", "dona", "kg", "шт" is a quantity (initialQty); of two money amounts the larger is salePrice and the smaller costPrice. If the meaning of a number is unclear, put the most price-like one in salePrice and mention the rest in notes.
- Money: "12 500", "12.500", "12,500", "12,5 ming", "12.5k", "12 500 so‘m" all mean 12500 so‘m. Write money as plain digits ("12500"). Quantities as digits ("24", "1.5").
- If the same product appears in several photos (overlapping shots of a long list), return it ONCE and list every photo index (0-based, in the order sent) in imageIndexes.

Field rules:
- name: the product as written in the list, with obvious handwriting/OCR slips fixed and abbreviations kept readable (e.g. "Coca-Cola 1.5 l", "Shakar 1 kg", "Non tandir"). Keep the original language of the product name; transliterate Cyrillic Uzbek to Latin Uzbek. Max 200 characters.
- description: null unless the list itself has extra detail worth keeping (max 200 characters).
- unit: KG when the row is clearly sold by weight (kg / кг, or loose goods like sugar, rice, flour, meat sold per kg); LITER only for loose liquids sold by volume; BOX for whole boxes/blocks; METER for goods sold by length; otherwise PIECE.
- NEVER guess numbers. salePrice / costPrice / initialQty only when written; barcode only if all 8-14 digits are clearly legible. Otherwise null.
- categoryId: the id of the best matching category from the provided list. If none fits, null and propose a short Uzbek newCategoryName (reuse the same new name for similar products). Never set both.
- Text you write yourself (notes, newCategoryName, description) is in Uzbek, Latin script, with the apostrophes ‘ and ’ (o‘, g‘, ma’lumot).
- confidence: high = name and price clearly legible; medium = small doubts; low = hard to read or guessed reading.
- notes: what the user should double-check (e.g. "narx noaniq o‘qildi", "2-son miqdor bo‘lishi mumkin"), or null.
- If no list rows or products are visible, return an empty drafts list.
- Respond with JSON only, matching the requested schema.`;

/** Vaqtincha xato (band, limit, tarmoq) — boshqa model/provayder bilan qayta urinish mumkin. */
class RetryableAiError extends BadGatewayException {
  constructor() {
    super(MSG_UNAVAILABLE);
  }
}

const RETRY_DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "a, b ,c" → ["a","b","c"] */
function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** "12 500", "12500.5" → "12500.00"; boshqasi → null. */
function money(v: string | null): string | null {
  const s = v?.trim().replace(/\s/g, '') ?? '';
  return /^\d+(\.\d{1,2})?$/.test(s) && Number(s) > 0 ? Number(s).toFixed(2) : null;
}

interface ImageInput {
  mime: AllowedMime;
  b64: string;
}

@Injectable()
export class AiDraftService {
  private readonly logger = new Logger(AiDraftService.name);
  private claude: Anthropic | null = null;
  private gemini: GoogleGenAI | null = null;

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
      return { drafts: this.mockDrafts(files.length), model: 'mock' };
    }

    const providers = this.resolveProviders();
    if (providers.length === 0) throw new ServiceUnavailableException(MSG_NOT_CONFIGURED);

    const categories = await this.prisma.category.findMany({
      where: { storeId: user.storeId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const images: ImageInput[] = files.map((f) => ({ mime: f.mimetype as AllowedMime, b64: f.buffer.toString('base64') }));
    const userText =
      `Photos sent: ${files.length} (indexes 0..${files.length - 1}).\n` +
      `Existing categories (JSON): ${JSON.stringify(categories)}\n` +
      'Read the list and return one draft per product row.';

    // Provayderlar zanjiri: biri band/xato bo‘lsa — keyingisi. Oxirgi xato foydalanuvchiga qaytariladi.
    let lastError: unknown = new ServiceUnavailableException(MSG_NOT_CONFIGURED);
    for (const provider of providers) {
      try {
        const result =
          provider === 'gemini'
            ? await this.callGemini(images, userText)
            : provider === 'openrouter'
              ? await this.callOpenRouter(images, userText)
              : await this.callClaude(images, userText);
        return { drafts: this.normalize(result.output.drafts, categories, files.length), model: result.model };
      } catch (e) {
        lastError = e;
        this.logger.warn(`${provider} ishlamadi, keyingi provayder sinab ko‘riladi`);
      }
    }
    throw lastError;
  }

  /** AI_PROVIDER ro‘yxati (vergul bilan) — kaliti borlari, berilgan tartibda; bo‘sh bo‘lsa kaliti bor hammasi. */
  private resolveProviders(): Provider[] {
    const has: Record<Provider, boolean> = {
      gemini: !!process.env.GEMINI_API_KEY?.trim(),
      openrouter: !!process.env.OPENROUTER_API_KEY?.trim(),
      claude: !!process.env.ANTHROPIC_API_KEY?.trim(),
    };
    const all: Provider[] = ['gemini', 'openrouter', 'claude'];
    const wanted = splitList(process.env.AI_PROVIDER).filter((p): p is Provider => (all as string[]).includes(p));
    return [...new Set(wanted.length ? wanted : all)].filter((p) => has[p]);
  }

  // ---------- Gemini (@google/genai) ----------

  private async callGemini(images: ImageInput[], userText: string): Promise<{ output: DraftOutput; model: string }> {
    const models = splitList(process.env.GEMINI_MODEL);
    if (models.length === 0) models.push(DEFAULT_GEMINI_MODEL);
    this.gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim(), httpOptions: { timeout: REQUEST_TIMEOUT_MS } });

    let lastError: unknown;
    for (const model of models) {
      // Band (503/429/500) bo‘lsa — qisqa kutib bir marta qayta; baribir bo‘lmasa keyingi model
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await this.geminiOnce(model, images, userText);
        } catch (e) {
          lastError = e;
          if (e instanceof ServiceUnavailableException) throw e; // kalit noto‘g‘ri — boshqa model ham yordam bermaydi
          const busy = e instanceof RetryableAiError;
          if (!busy || attempt === 2) break;
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }

  private async geminiOnce(model: string, images: ImageInput[], userText: string): Promise<{ output: DraftOutput; model: string }> {
    const parts = [...images.map((i) => ({ inlineData: { mimeType: i.mime, data: i.b64 } })), { text: userText }];
    let text: string | undefined;
    try {
      const response = await this.gemini!.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseJsonSchema: DRAFT_JSON_SCHEMA,
          maxOutputTokens: 32768,
        },
      });
      text = response.text;
      if (!text) {
        // Javob bo‘sh — odatda xavfsizlik filtri to‘xtatgan
        this.logger.warn(`Gemini (${model}) bo‘sh javob: ${JSON.stringify(response.promptFeedback ?? response.candidates?.[0]?.finishReason ?? null)}`);
        throw new UnprocessableEntityException(MSG_REFUSED);
      }
    } catch (e) {
      if (e instanceof UnprocessableEntityException) throw e;
      if (e instanceof GeminiApiError) {
        this.logger.error(`Gemini (${model}) xatosi (${e.status}): ${e.message.slice(0, 300)}`);
        if (e.status === 401 || e.status === 403) throw new ServiceUnavailableException(MSG_KEY_REJECTED);
        if (e.status === 429 || e.status >= 500) throw new RetryableAiError();
        throw new BadGatewayException(MSG_UNAVAILABLE);
      }
      this.logger.error(`Gemini (${model}) kutilmagan xato: ${e instanceof Error ? e.message : String(e)}`);
      throw new RetryableAiError();
    }
    return { output: this.parseJson(text, `Gemini ${model}`), model };
  }

  // ---------- OpenRouter (OpenAI-mos HTTP API) ----------

  private async callOpenRouter(images: ImageInput[], userText: string): Promise<{ output: DraftOutput; model: string }> {
    const models = splitList(process.env.OPENROUTER_MODEL);
    if (models.length === 0) {
      throw new ServiceUnavailableException(
        'OPENROUTER_MODEL ko‘rsatilmagan. .env ga rasmni o‘qiy oladigan model nomini yozing (bir nechtasini vergul bilan).',
      );
    }
    let lastError: unknown;
    for (const model of models) {
      try {
        return await this.openRouterOnce(model, images, userText);
      } catch (e) {
        lastError = e;
        if (e instanceof ServiceUnavailableException) throw e; // kalit/balans muammosi — boshqa model ham yordam bermaydi
      }
    }
    throw lastError;
  }

  private async openRouterOnce(model: string, images: ImageInput[], userText: string): Promise<{ output: DraftOutput; model: string }> {
    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!.trim()}`,
          'Content-Type': 'application/json',
          'X-Title': 'VAFLO.UZ',
        },
        body: JSON.stringify({
          model,
          max_tokens: 16000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.b64}` } })),
                // Structured outputs’ni qo‘llamaydigan (ko‘p bepul) modellar uchun sxema matnda ham beriladi
                { type: 'text', text: `${userText}\nJSON schema:\n${JSON.stringify(DRAFT_JSON_SCHEMA)}` },
              ],
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'product_drafts', strict: true, schema: DRAFT_JSON_SCHEMA },
          },
        }),
      });
    } catch (e) {
      this.logger.error(`OpenRouter (${model}) tarmoq xatosi: ${e instanceof Error ? e.message : String(e)}`);
      throw new RetryableAiError();
    }

    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string; error?: { code: number; message: string } }[];
      error?: { code?: number; message?: string };
    } | null;

    if (!res.ok) {
      this.logger.error(`OpenRouter (${model}) xatosi (${res.status}): ${body?.error?.message?.slice(0, 300) ?? 'javob yo‘q'}`);
      if (res.status === 401 || res.status === 402 || res.status === 403) throw new ServiceUnavailableException(MSG_KEY_REJECTED);
      throw new RetryableAiError();
    }

    const choice = body?.choices?.[0];
    if (choice?.error) {
      this.logger.error(`OpenRouter (${model}) model xatosi (${choice.error.code}): ${choice.error.message.slice(0, 300)}`);
      throw new RetryableAiError();
    }
    if (choice?.finish_reason === 'content_filter') throw new UnprocessableEntityException(MSG_REFUSED);
    const text = choice?.message?.content;
    if (!text) {
      this.logger.error(`OpenRouter (${model}) bo‘sh javob (finish_reason: ${choice?.finish_reason ?? '—'})`);
      throw new RetryableAiError();
    }
    return { output: this.parseJson(text, `OpenRouter ${model}`), model };
  }

  // ---------- Claude (@anthropic-ai/sdk) ----------

  private async callClaude(images: ImageInput[], userText: string): Promise<{ output: DraftOutput; model: string }> {
    const model = splitList(process.env.ANTHROPIC_MODEL)[0] ?? DEFAULT_CLAUDE_MODEL;
    this.claude ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!.trim() });

    const content: Anthropic.ContentBlockParam[] = images.map((i) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: i.mime, data: i.b64 },
    }));
    content.push({ type: 'text', text: userText });

    let parsed: DraftOutput | null;
    try {
      const response = await this.claude.messages.parse({
        model,
        max_tokens: 16000,
        output_config: { effort: 'medium', format: zodOutputFormat(DraftSchema) },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      });
      if (response.stop_reason === 'refusal') throw new UnprocessableEntityException(MSG_REFUSED);
      parsed = response.parsed_output;
    } catch (e) {
      if (e instanceof UnprocessableEntityException) throw e;
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        this.logger.error(`Anthropic kalit xatosi (${e.status}): ${e.message}`);
        throw new ServiceUnavailableException(MSG_KEY_REJECTED);
      }
      if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIError) {
        this.logger.error(`Anthropic xatosi: ${e.constructor.name}: ${e.message}`);
        throw new BadGatewayException(MSG_UNAVAILABLE);
      }
      this.logger.error(`Anthropic kutilmagan xato: ${e instanceof Error ? e.message : String(e)}`);
      throw new BadGatewayException(MSG_UNAVAILABLE);
    }
    if (!parsed) {
      this.logger.error('Anthropic javobi parse qilinmadi (parsed_output null)');
      throw new BadGatewayException(MSG_UNAVAILABLE);
    }
    return { output: parsed, model };
  }

  // ---------- Umumiy ----------

  /** Model qaytargan JSON matnni sxema bo‘yicha tekshiradi (ba’zan ```json ... ``` ichida keladi). */
  private parseJson(text: string, source: string): DraftOutput {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let data: unknown;
    try {
      data = JSON.parse(cleaned);
    } catch {
      this.logger.error(`${source}: javob JSON emas`);
      throw new BadGatewayException(MSG_UNAVAILABLE);
    }
    const r = DraftSchema.safeParse(data);
    if (!r.success) {
      this.logger.error(`${source}: javob sxemaga mos emas: ${r.error.message.slice(0, 500)}`);
      throw new BadGatewayException(MSG_UNAVAILABLE);
    }
    return r.data;
  }

  private normalize(
    raw: DraftOutput['drafts'],
    categories: { id: string; name: string }[],
    imageCount: number,
  ): ProductDraft[] {
    const ids = new Set(categories.map((c) => c.id));
    const out: ProductDraft[] = [];
    for (const d of raw) {
      const name = d.name.trim().slice(0, 200);
      if (!name) continue;

      const salePrice = money(d.salePrice);
      const costPrice = money(d.costPrice);
      const qtyRaw = d.initialQty?.trim().replace(/\s/g, '').replace(',', '.') ?? '';
      const initialQty = /^\d+(\.\d{1,3})?$/.test(qtyRaw) && Number(qtyRaw) > 0 ? String(Number(qtyRaw)) : null;

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
        costPrice,
        initialQty,
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
        costPrice: '9500.00',
        initialQty: '24',
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
        costPrice: null,
        initialQty: null,
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
