/**
 * Currency engine.
 *
 * No currency code is hardcoded anywhere else in the application: every
 * monetary record stores its own ISO code, and the administrator chooses the
 * platform default plus which currencies are selectable.
 */

export const DEFAULT_CURRENCY = 'SAR';

export const CURRENCY_CATALOG = [
  { code: 'SAR', name: 'Saudi Riyal', region: 'Saudi Arabia' },
  { code: 'AED', name: 'UAE Dirham', region: 'United Arab Emirates' },
  { code: 'USD', name: 'US Dollar', region: 'United States' },
  { code: 'EUR', name: 'Euro', region: 'European Union' },
  { code: 'GBP', name: 'Pound Sterling', region: 'United Kingdom' },
  { code: 'QAR', name: 'Qatari Riyal', region: 'Qatar' },
  { code: 'KWD', name: 'Kuwaiti Dinar', region: 'Kuwait' },
  { code: 'BHD', name: 'Bahraini Dinar', region: 'Bahrain' },
  { code: 'OMR', name: 'Omani Rial', region: 'Oman' },
  { code: 'JOD', name: 'Jordanian Dinar', region: 'Jordan' },
  { code: 'EGP', name: 'Egyptian Pound', region: 'Egypt' },
  { code: 'PKR', name: 'Pakistani Rupee', region: 'Pakistan' },
  { code: 'INR', name: 'Indian Rupee', region: 'India' },
  { code: 'BDT', name: 'Bangladeshi Taka', region: 'Bangladesh' },
  { code: 'PHP', name: 'Philippine Peso', region: 'Philippines' },
  { code: 'IDR', name: 'Indonesian Rupiah', region: 'Indonesia' },
  { code: 'MYR', name: 'Malaysian Ringgit', region: 'Malaysia' },
  { code: 'TRY', name: 'Turkish Lira', region: 'Türkiye' },
  { code: 'MAD', name: 'Moroccan Dirham', region: 'Morocco' },
  { code: 'TND', name: 'Tunisian Dinar', region: 'Tunisia' },
  { code: 'KES', name: 'Kenyan Shilling', region: 'Kenya' },
  { code: 'NGN', name: 'Nigerian Naira', region: 'Nigeria' },
  { code: 'ZAR', name: 'South African Rand', region: 'South Africa' },
  { code: 'CNY', name: 'Chinese Yuan', region: 'China' },
  { code: 'CAD', name: 'Canadian Dollar', region: 'Canada' },
  { code: 'AUD', name: 'Australian Dollar', region: 'Australia' },
  { code: 'CHF', name: 'Swiss Franc', region: 'Switzerland' },
  { code: 'SEK', name: 'Swedish Krona', region: 'Sweden' },
  { code: 'NOK', name: 'Norwegian Krone', region: 'Norway' },
  { code: 'RUB', name: 'Russian Ruble', region: 'Russia' },
  { code: 'BRL', name: 'Brazilian Real', region: 'Brazil' }
];

const CATALOG_BY_CODE = new Map(CURRENCY_CATALOG.map((c) => [c.code, c]));

/** Currencies enabled out of the box (the administrator can change this list). */
const DEFAULT_ENABLED = ['SAR', 'AED', 'USD', 'EUR', 'GBP', 'QAR', 'KWD', 'EGP', 'PKR', 'INR', 'BDT', 'PHP'];

export function isKnownCurrency(code) {
  return CURRENCY_CATALOG.some((c) => c.code === String(code || '').toUpperCase());
}

/** Alias used by the route layer. */
export const isValidCurrency = isKnownCurrency;
  return CATALOG_BY_CODE.has(String(code || '').toUpperCase());
}

export function currencyMeta(code) {
  return CATALOG_BY_CODE.get(String(code || '').toUpperCase()) || null;
}

export function defaultCurrencySettings() {
  return {
    default_currency: DEFAULT_CURRENCY,
    currencies: CURRENCY_CATALOG.map((c) => ({
      code: c.code,
      enabled: DEFAULT_ENABLED.includes(c.code)
    }))
  };
}

/**
 * Accepts whatever is stored (possibly partial or legacy) and returns a
 * complete, valid currency configuration.
 */
export function normaliseCurrencySettings(input) {
  const base = defaultCurrencySettings();
  if (!input || typeof input !== 'object') return base;

  const seen = new Set();
  const currencies = [];
  for (const entry of Array.isArray(input.currencies) ? input.currencies : []) {
    const code = String(entry?.code || '').toUpperCase();
    if (!CATALOG_BY_CODE.has(code) || seen.has(code)) continue;
    seen.add(code);
    currencies.push({ code, enabled: entry.enabled !== false });
  }
  for (const entry of base.currencies) {
    if (!seen.has(entry.code)) currencies.push(entry);
  }

  let defaultCode = String(input.default_currency || base.default_currency).toUpperCase();
  if (!CATALOG_BY_CODE.has(defaultCode)) defaultCode = base.default_currency;
  // The default must always be selectable.
  const target = currencies.find((c) => c.code === defaultCode);
  if (target) target.enabled = true;

  return { default_currency: defaultCode, currencies };
}

export function enabledCurrencyCodes(settings) {
  const normalised = normaliseCurrencySettings(settings);
  return normalised.currencies.filter((c) => c.enabled).map((c) => c.code);
}

/** Resolves a requested currency to something that is actually selectable. */
export function resolveCurrency(code, settings) {
  const normalised = normaliseCurrencySettings(settings);
  const requested = String(code || '').toUpperCase();
  if (normalised.currencies.some((c) => c.code === requested && c.enabled)) return requested;
  return normalised.default_currency;
}

export function formatMoney(amount, code = DEFAULT_CURRENCY) {
  const n = Number(amount);
  const value = Number.isFinite(n) ? n : 0;
  const currency = isKnownCurrency(code) ? String(code).toUpperCase() : DEFAULT_CURRENCY;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
