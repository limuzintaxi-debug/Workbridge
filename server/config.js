import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'),
  sessionSecret: process.env.SESSION_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supportEmail: 'Limuzin@196vip.si',
  appUrl: process.env.APP_URL || '',
  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  setupToken: process.env.SETUP_TOKEN || '',
  // SMTP for password-recovery email. Gmail works with an app password.
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 587),
  smtpSecure:
    process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT || 587) === 465,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || '',
  // Password-recovery delivery. Resend needs only an API key, so no mailbox
  // password is required; SMTP remains available for any other provider.
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailProvider: (process.env.EMAIL_PROVIDER || '').toLowerCase(),
  emailCaptureDir: process.env.EMAIL_CAPTURE_DIR || '',
  // Single-use reset links expire after 30 minutes by default.
  resetTtlMs: Number(process.env.RESET_TTL_MS || 1000 * 60 * 30),
  seedDemo: process.env.SEED_DEMO === '1'
};

/**
 * Test harnesses must never touch the production database.
 *
 * Every suite spawns the server with NODE_ENV=test but spreads `process.env`,
 * so it inherits the real SUPABASE_* credentials from Settings. That was
 * harmless only while the database rejected the key with 403 and the app fell
 * back to the local JSON store; once reads were granted, the suites started
 * loading live data (the first admin already existed, so setup returned 409)
 * and a passing suite could write into production. Dropping the credentials
 * here keeps every test on the local JSON driver regardless of the harness.
 */
if (config.nodeEnv === 'test') {
  config.supabaseUrl = '';
  config.supabaseAnonKey = '';
  config.supabaseServiceKey = '';
}

export const isProduction = config.nodeEnv === 'production';

export function supabaseConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseServiceKey);
}

export function supabaseAuthConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey && config.supabaseServiceKey);
}

/** Public origin used to build links inside emails. */
export function publicOrigin(req) {
  if (config.appUrl) return config.appUrl.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}
