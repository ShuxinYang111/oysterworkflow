/**
 * EN: Public Supabase client configuration for the OysterWorkflow control plane.
 * 中文: OysterWorkflow 云端控制面的公开 Supabase 客户端配置。
 *
 * The publishable key is intentionally client-visible. Authorization is enforced
 * by Supabase Auth JWTs, PostgreSQL grants, and RLS. Never add a secret or
 * service-role key to this module.
 */
export const OYSTER_SUPABASE_URL = "https://endzbtyaapodhwkflrut.supabase.co";

export const OYSTER_SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_zE8ag6TrsVD1jXzfygmpAQ_XHRemxBN";

export const OYSTER_COMPOSIO_BROKER_URL = `${OYSTER_SUPABASE_URL}/functions/v1/composio-broker`;

export const OYSTER_AUTH_CALLBACK_URL = "oysterworkflow://auth/callback";
