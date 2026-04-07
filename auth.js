import { adminSupabase, userSupabase } from '../services/supabase.js';
import { ApiError } from './errorHandler.js';

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new ApiError('Missing Authorization header', 401);
    const token = header.slice(7);

    const { data: { user }, error } = await adminSupabase.auth.getUser(token);
    if (error || !user) throw new ApiError('Invalid or expired token', 401);

    const { data: profile, error: pErr } = await adminSupabase
      .from('user_profiles')
      .select('id, role, auth_source, carerix_user_id, carerix_company_id, display_name, is_active')
      .eq('id', user.id).single();

    if (pErr || !profile) throw new ApiError('User profile not found', 401);
    if (!profile.is_active) throw new ApiError('Account is inactive', 403);

    req.user     = { ...user, ...profile };
    req.token    = token;
    req.supabase = userSupabase(token);
    next();
  } catch (err) { next(err); }
}

export const requireAgency = (req, res, next) => {
  if (!['agency_admin', 'agency_operations'].includes(req.user?.role))
    return next(new ApiError('Agency access required', 403));
  next();
};

export const requireCompanyOrAbove = (req, res, next) => {
  if (!['agency_admin', 'agency_operations', 'company_admin', 'company_user'].includes(req.user?.role))
    return next(new ApiError('Company or Agency access required', 403));
  next();
};
