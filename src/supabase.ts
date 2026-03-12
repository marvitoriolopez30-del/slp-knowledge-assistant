import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
