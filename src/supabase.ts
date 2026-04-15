import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured = !!supabaseUrl && 
  !!supabaseAnonKey && 
  supabaseUrl.startsWith('https://') && 
  !supabaseUrl.includes('placeholder') &&
  !supabaseUrl.includes('YOUR_SUPABASE_URL') &&
  supabaseUrl.length > 20; // Basic length check for a real URL

export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : 'https://placeholder-project.supabase.co', 
  isSupabaseConfigured ? supabaseAnonKey : 'placeholder-key'
);

export type UserRole = 'admin' | 'user';
export type UserStatus = 'pending' | 'approved' | 'rejected';

export interface Profile {
  id: string;
  email: string;
  full_name?: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
}

export interface Document {
  id: string;
  file_name: string;
  folder: string;
  file_url: string;
  uploaded_by: string;
  created_at: string;
}

export interface Beneficiary {
  id: string;
  name: string;
  status: string;
}

export const FOLDERS = [
  'GUIDELINES',
  'TEMPLATES AND FORMS',
  'SLPIS',
  'DPT',
  'ACTIVITY PHOTO',
  'OTHER FILES'
];
