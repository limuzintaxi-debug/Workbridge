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
  seedDemo: process.env.SEED_DEMO === '1'
};

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
