# AI orqali mahsulot qo‘shish — API shartnomasi

Foydalanuvchi 1–5 ta mahsulot rasmini yuboradi → backend Claude (vision) orqali rasmlarni tahlil qiladi →
**bazaga hech narsa yozmasdan** mahsulot qoralamalari ro‘yxatini qaytaradi → frontend ro‘yxatni ko‘rsatadi,
foydalanuvchi tahrirlab tasdiqlaydi → frontend mavjud `POST /api/v1/products` (va kerak bo‘lsa
`POST /api/v1/categories`) orqali yaratadi.

## Endpoint

`POST /api/v1/products/ai-draft` — `multipart/form-data`

- Ruxsat: `products.manage` (`@RequirePermissions('products.manage')`), do‘kon scope — joriy foydalanuvchi do‘koni.
- Maydon: `images` — 1..5 fayl, har biri ≤ 5 MB, `image/jpeg | image/png | image/webp | image/gif`.
  (Frontend yuborishdan oldin rasmni ≤ 1600px JPEG ga kichraytiradi.)
- Throttle: foydalanuvchiga 10 so‘rov / daqiqa.

### 200 javob

```json
{
  "drafts": [
    {
      "name": "Coca-Cola 1.5 l",
      "description": "Gazlangan ichimlik, plastik shisha",
      "unit": "PIECE",
      "salePrice": "12500.00",
      "barcode": "5449000000996",
      "categoryId": "uuid-yoki-null",
      "newCategoryName": null,
      "confidence": "high",
      "imageIndexes": [0, 2],
      "notes": "Narx yorlig‘idan o‘qildi"
    }
  ],
  "model": "claude-opus-5-5"
}
```

| Maydon | Tur | Qoida |
|---|---|---|
| `name` | string (1–200) | Qadoqdagi nom; brend + tur + hajm/og‘irlik (masalan "Coca-Cola 1.5 l"). O‘zbekcha (lotin), brend nomlari asl holicha. |
| `description` | string \| null | Qisqa (≤ 200 belgi). |
| `unit` | `PIECE \| KG \| LITER \| BOX \| METER` | Odatda qadoqlangan mahsulot — `PIECE`; tarozida sotiladigan — `KG`. |
| `salePrice` | string \| null | Faqat rasmda narx yorlig‘i **aniq ko‘rinsa**, so‘mda, `"12500.00"` formatida. Aks holda `null` (taxmin qilinmaydi). |
| `barcode` | string \| null | Faqat shtrix-kod raqamlari **aniq o‘qilsa** (8–14 raqam). Aks holda `null`. |
| `categoryId` | uuid \| null | Do‘konning mavjud kategoriyalaridan mosi bo‘lsa. |
| `newCategoryName` | string \| null | Mos kategoriya yo‘q bo‘lsa — taklif qilinadigan yangi nom (aks holda `null`). `categoryId` bilan bir vaqtda to‘ldirilmaydi. |
| `confidence` | `high \| medium \| low` | Mahsulotni aniqlash ishonchi. |
| `imageIndexes` | number[] | Mahsulot qaysi rasmlarda ko‘rinadi (0 dan). |
| `notes` | string \| null | Foydalanuvchi tekshirishi kerak bo‘lgan narsa (masalan "hajmi ko‘rinmadi"). |

Bir xil mahsulot bir nechta rasmda bo‘lsa — **bitta** qoralama. Rasmda mahsulot bo‘lmasa — `drafts: []`.

### Xatolar (standart `ApiError` formati, `message` o‘zbekcha)

| Holat | Status | message |
|---|---|---|
| Rasm yo‘q / 5 tadan ko‘p / turi noto‘g‘ri / 5 MB dan katta | 400 | aniq sabab |
| `ANTHROPIC_API_KEY` sozlanmagan (va mock o‘chiq) | 503 | "AI xizmati sozlanmagan. Administrator ANTHROPIC_API_KEY ni qo‘shishi kerak." |
| Claude rad etdi (`stop_reason: refusal`) | 422 | "AI bu rasmlarni tahlil qila olmadi. Boshqa rasm yuboring." |
| Claude API xatosi (429/5xx/tarmoq) | 502 | "AI xizmati vaqtincha javob bermayapti. Birozdan keyin qayta urinib ko‘ring." |

### Lokal sinov rejimi

`AI_PRODUCT_DRAFT_MOCK=1` **va** `NODE_ENV !== 'production'` bo‘lsa — Claude chaqirilmaydi, 1.5 s kutib,
2 ta namunaviy qoralama qaytariladi (bittasida `salePrice: null`, bittasida `newCategoryName`). Faqat UI ni kalitsiz sinash uchun.
