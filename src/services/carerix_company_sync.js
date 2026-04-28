/**
 * Carerix company importer.
 *
 * Pulls CRCompany + its active CRJobs + CRUserCompany links for a given
 * `companyID` (the integer one users reference — e.g. 7, 658, 698) and
 * upserts them into our tables:
 *
 *   companies                — 1 row per Carerix company (by carerix_company_id)
 *   placements               — 1 row per active CRJob (by carerix_job_id)
 *   user_profiles            — 1 row per CRUser (by carerix_user_id = CRUser._id)
 *   user_company_access      — junction (user_profile_id, company_id)
 *
 * Idempotent. Run once per company to seed; re-run any time to refresh.
 */
import { adminSupabase } from './supabase.js';
import { queryGraphQL }   from './carerix.js';
import { logger }         from '../utils/logger.js';

const CREW_CODE_FIELD = '10189'; // additionalInfo key carrying the crew code (3 or 4 letters)

// ── GraphQL fragments ─────────────────────────────────────────────────────────

const CR_COMPANY_Q = `
  query Company($qualifier: String) {
    crCompanyPage(qualifier: $qualifier, pageable: { page: 0, size: 1 }) {
      items {
        _id companyID name correspondenceName shortName
        agency { _id }
      }
    }
  }`;

const CR_JOBS_Q = `
  query JobsForCompany($qualifier: String, $pageable: Pageable) {
    crJobPage(qualifier: $qualifier, pageable: $pageable) {
      totalElements
      items {
        _id jobID name
        startDate endDate deleted status statusDisplay
        additionalInfo
        toStatusNode { _id value dataNodeID active notActive tag }
        toCompany { _id companyID }
        toEmployee {
          _id employeeID firstName lastName emailAddress
          paymentIbanCode paymentBicCode paymentAccountName
          toFunction1Level1Node { _id dataNodeID value label }
        }
      }
    }
  }`;

const CR_USER_COMPANY_Q = `
  query UsersForCompany($qualifier: String, $pageable: Pageable) {
    crUserCompanyPage(qualifier: $qualifier, pageable: $pageable) {
      totalElements
      items {
        _id
        toCompany { _id companyID }
        toUser {
          _id userID userName firstName lastName
          emailAddress emailAddressBusiness
          isActive deleted
        }
      }
    }
  }`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function str(v) { return v == null ? '' : String(v); }

// Crew codes in Carerix are 3 OR 4 uppercase letters (e.g. BNY = Benony,
// BENO = Benoit). Anything else is treated as "no code".
const CREW_CODE_REGEX = /^[A-Z]{3,4}$/;

function crewCodeFromJob(job) {
  const ai = job?.additionalInfo;
  if (!ai || typeof ai !== 'object') return null;
  const raw = ai[CREW_CODE_FIELD] ?? ai[`_${CREW_CODE_FIELD}`] ?? null;
  if (!raw) return null;
  const code = String(raw).trim().toUpperCase();
  return CREW_CODE_REGEX.test(code) ? code : null;
}

function isoDateOrNull(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Paginate a GraphQL list query; query must accept { qualifier, pageable }. */
async function paginate(query, qualifier, field) {
  const all = [];
  let page = 0;
  const size = 100;
  while (true) {
    const res = await queryGraphQL(query, { qualifier, pageable: { page, size } }, { timeoutMs: 60_000 });
    const items = res?.data?.[field]?.items || [];
    const total = res?.data?.[field]?.totalElements ?? items.length;
    all.push(...items);
    page++;
    if (all.length >= total || items.length < size) break;
    if (page > 100) break; // safety
  }
  return all;
}

// ── Upserts ───────────────────────────────────────────────────────────────────

async function upsertCompany(crCompany) {
  const row = {
    carerix_company_id: String(crCompany.companyID),
    name: crCompany.name || crCompany.correspondenceName || `Company ${crCompany.companyID}`,
    company_ref: crCompany._id ? String(crCompany._id) : null,
    carerix_agency_id: crCompany.agency?._id ? String(crCompany.agency._id) : null,
    is_active: true,
  };
  const { data: existing } = await adminSupabase
    .from('companies').select('id')
    .eq('carerix_company_id', row.carerix_company_id)
    .maybeSingle();

  if (existing) {
    await adminSupabase.from('companies').update(row).eq('id', existing.id);
    return existing.id;
  }
  const { data: inserted, error } = await adminSupabase
    .from('companies').insert(row).select('id').single();
  if (error) throw new Error(`company upsert: ${error.message}`);
  return inserted.id;
}

async function upsertPlacement(companyId, crJob) {
  const carerixJobId = String(crJob.jobID);
  const carerixPlacementId = crJob._id ? String(crJob._id) : null;
  const crewId = crewCodeFromJob(crJob);
  const emp = crJob.toEmployee || {};
  const fullName = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || crJob.name || crewId || 'Unknown';

  const fn = emp?.toFunction1Level1Node || null;
  const carerixFunctionGroup = fn?.value || fn?.label || null;
  const carerixFunctionGroupId = fn?.dataNodeID != null ? Number(fn.dataNodeID) : null;

  const st = crJob?.toStatusNode || null;
  const carerixStatusValue     = st?.value ?? null;
  const carerixStatusId        = st?.dataNodeID != null ? Number(st.dataNodeID) : null;
  const carerixStatusTag       = st?.tag ?? null;
  const carerixStatusActive    = st?.active != null ? Number(st.active) : null;
  const carerixStatusNotActive = st?.notActive != null ? Number(st.notActive) : null;

  const fields = {
    company_id:                 companyId,
    carerix_job_id:             carerixJobId,
    carerix_placement_id:       carerixPlacementId,
    full_name:                  fullName,
    email:                      emp.emailAddress || null,
    crew_id:                    crewId,
    start_date:                 isoDateOrNull(crJob.startDate),
    end_date:                   isoDateOrNull(crJob.endDate),
    inv_iban:                   emp.paymentIbanCode || null,
    inv_bic:                    emp.paymentBicCode || null,
    inv_account_name:           emp.paymentAccountName || null,
    carerix_function_group:     carerixFunctionGroup,
    carerix_function_group_id:  carerixFunctionGroupId,
    carerix_status_value:       carerixStatusValue,
    carerix_status_id:          carerixStatusId,
    carerix_status_tag:         carerixStatusTag,
    carerix_status_active:      carerixStatusActive,
    carerix_status_notactive:   carerixStatusNotActive,
  };

  const { data: byJob } = await adminSupabase
    .from('placements').select('id')
    .eq('carerix_job_id', carerixJobId).maybeSingle();
  if (byJob) {
    await adminSupabase.from('placements').update(fields).eq('id', byJob.id);
    return { id: byJob.id, matched: 'carerix_job_id', created: false };
  }

  if (crewId) {
    const { data: byCrew } = await adminSupabase
      .from('placements').select('id')
      .eq('company_id', companyId).eq('crew_id', crewId).maybeSingle();
    if (byCrew) {
      await adminSupabase.from('placements').update(fields).eq('id', byCrew.id);
      return { id: byCrew.id, matched: 'crew_id+company', created: false };
    }
  }

  const { data: ins, error } = await adminSupabase
    .from('placements').insert(fields).select('id').single();
  if (error) throw new Error(`placement insert: ${error.message}`);
  return { id: ins.id, matched: 'inserted', created: true };
}

async function upsertUserProfile(companyId, cru) {
  const carerixUserId = String(cru._id);
  const email = cru.emailAddressBusiness || cru.emailAddress || null;
  const displayName = [cru.firstName, cru.lastName].filter(Boolean).join(' ') || cru.userName || 'User';

  const fields = {
    role: 'company_user',
    auth_source: 'carerix',
    carerix_user_id: carerixUserId,
    display_name: displayName,
    email,
    is_active: Number(cru.isActive) === 1,
  };

  const { data: existing } = await adminSupabase
    .from('user_profiles').select('id')
    .eq('carerix_user_id', carerixUserId).maybeSingle();

  let userProfileId;
  if (existing) {
    await adminSupabase.from('user_profiles').update(fields).eq('id', existing.id);
    userProfileId = existing.id;
  } else {
    const { data: ins, error } = await adminSupabase
      .from('user_profiles').insert(fields).select('id').single();
    if (error) throw new Error(`user_profiles insert: ${error.message}`);
    userProfileId = ins.id;
  }

  await adminSupabase.from('user_company_access')
    .upsert({ user_profile_id: userProfileId, company_id: companyId },
            { onConflict: 'user_profile_id,company_id', ignoreDuplicates: true });
  return userProfileId;
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function syncCarerixCompany(carerixCompanyID, emit = () => {}) {
  const result = {
    carerixCompanyID: Number(carerixCompanyID),
    company: null,
    placements: { processed: 0, created: 0, updated: 0, errors: [] },
    users:      { processed: 0, created: 0, updated: 0, errors: [] },
  };

  emit('started', { carerixCompanyID: Number(carerixCompanyID) });

  const companyResp = await queryGraphQL(CR_COMPANY_Q, {
    qualifier: `companyID == ${Number(carerixCompanyID)}`,
  });
  const crCompany = companyResp?.data?.crCompanyPage?.items?.[0];
  if (!crCompany) throw new Error(`Carerix company ${carerixCompanyID} not found`);
  const companyId = await upsertCompany(crCompany);
  result.company = {
    id: companyId,
    carerix_company_id: String(crCompany.companyID),
    name: crCompany.name,
  };
  emit('company', result.company);

  const jobsQualifier =
    `toCompany.companyID == ${Number(carerixCompanyID)} AND deleted == 0`;

  emit('jobs_fetching', { qualifier: jobsQualifier });
  const allJobs = await paginate(CR_JOBS_Q, jobsQualifier, 'crJobPage');
  const todayStr = new Date().toISOString().split('T')[0];
  const jobs = allJobs.filter(j => {
    const s = isoDateOrNull(j?.startDate);
    const e = isoDateOrNull(j?.endDate);
    if (!s) return false;
    if (s > todayStr) return false;
    if (e && e < todayStr) return false;
    return true;
  });
  result.placements.fetched = allJobs.length;
  result.placements.filtered_active = jobs.length;
  emit('jobs_fetched', { total: allJobs.length, active: jobs.length });

  let pIdx = 0;
  for (const job of jobs) {
    pIdx++;
    try {
      const r = await upsertPlacement(companyId, job);
      result.placements.processed++;
      if (r.created) result.placements.created++;
      else           result.placements.updated++;
      if (pIdx % 10 === 0 || pIdx === jobs.length) {
        emit('placements_progress', {
          done: pIdx, total: jobs.length,
          created: result.placements.created,
          updated: result.placements.updated,
        });
      }
    } catch (e) {
      result.placements.errors.push({ jobID: job.jobID, error: e.message });
      emit('placement_error', { jobID: job.jobID, error: e.message });
      logger.warn('placement upsert failed', { jobID: job.jobID, error: e.message });
    }
  }
  emit('placements_done', result.placements);

  const userQualifier =
    `toCompany.companyID == ${Number(carerixCompanyID)} ` +
    `AND toUser.isActive == 1 AND toUser.deleted == 0`;

  emit('users_fetching', { qualifier: userQualifier });
  const links = await paginate(CR_USER_COMPANY_Q, userQualifier, 'crUserCompanyPage');
  emit('users_fetched', { total: links.length });

  let uIdx = 0;
  for (const link of links) {
    uIdx++;
    const cru = link?.toUser;
    if (!cru) continue;
    try {
      const before = await adminSupabase.from('user_profiles')
        .select('id').eq('carerix_user_id', String(cru._id)).maybeSingle();
      await upsertUserProfile(companyId, cru);
      result.users.processed++;
      if (before.data) result.users.updated++;
      else             result.users.created++;
      if (uIdx % 10 === 0 || uIdx === links.length) {
        emit('users_progress', {
          done: uIdx, total: links.length,
          created: result.users.created,
          updated: result.users.updated,
        });
      }
    } catch (e) {
      result.users.errors.push({ userID: cru.userID, _id: cru._id, error: e.message });
      emit('user_error', { userID: cru.userID, _id: cru._id, error: e.message });
      logger.warn('user upsert failed', { userID: cru.userID, error: e.message });
    }
  }
  emit('users_done', result.users);

  return result;
}
