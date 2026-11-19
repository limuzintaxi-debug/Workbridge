import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data'),
  sessionSecret: process.env.SESSION_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supportEmail: 'Limuzin@196vip.si'
};

export function supabaseConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseServiceKey);
}
