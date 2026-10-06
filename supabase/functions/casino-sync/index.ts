/* casino-sync: the Casino tab's odds, outcomes and settlement, once a minute.
 *
 * Deploy:   npx supabase@latest functions deploy casino-sync --use-api --no-verify-jwt --project-ref qwgwaedeuihvneirbplb
 * Secrets:  npx supabase@latest secrets set CRON_SECRET=<long random string> --project-ref qwgwaedeuihvneirbplb
 * Schedule: supabase/casino-cron.sql (pg_cron + pg_net), sending the same secret.
 *
 * Runs with the service role Supabase injects (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY), which is the only identity allowed to write
 * lines or settle bets. Everything that decides money is in ../_shared, where
 * the Node tests exercise it; this file only wires real I/O to it.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { runSync } from '../_shared/sync.mjs';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } });
const SITE = Deno.env.get('SITE_URL') ?? 'https://wcxcdynasty.site';

async function get(url: string) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (wcxc casino sync)', accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const must = <T>({ data, error }: { data: T; error: unknown }) => {
  if (error) throw new Error(JSON.stringify(error));
  return data;
};
const quoted = (ids: string[]) => `(${ids.map(i => `"${i.replace(/"/g, '')}"`).join(',')})`;

const adapter = {
  rules: async () => must(await db.from('casino_rules').select('*').eq('id', 1).single()),
  updateRules: async (patch: Record<string, unknown>) => { must(await db.from('casino_rules').update(patch).eq('id', 1)); },
  linesForEvents: async (events: string[]) => events.length
    ? must(await db.from('casino_lines').select('id,price,point,score,status,state').eq('sport', 'nfl').in('event', events)) ?? []
    : [],
  closeStarted: async (iso: string) => {
    must(await db.from('casino_lines').update({ status: 'closed' }).eq('state', 'pre').neq('status', 'closed').lte('commence_at', iso));
  },
  closeEvent: async (event: string, state: string, sports: string[]) => {
    must(await db.from('casino_lines').update({ status: 'closed', state }).eq('event', event).in('sport', sports).neq('status', 'closed'));
  },
  closeMissing: async (event: string, sport: string, keep: string[]) => {
    let q = db.from('casino_lines').update({ status: 'closed' }).eq('event', event).eq('sport', sport).neq('status', 'closed');
    if (keep.length) q = q.not('id', 'in', quoted(keep));
    must(await q);
  },
  suspendMissing: async (event: string, sport: string, keep: string[]) => {
    let q = db.from('casino_lines').update({ status: 'suspended' }).eq('event', event).eq('sport', sport).eq('status', 'open');
    if (keep.length) q = q.not('id', 'in', quoted(keep));
    must(await q);
  },
  upsertLines: async (rows: Record<string, unknown>[]) => {
    // rows carry a 512-byte simulation each, so keep requests modest
    for (let i = 0; i < rows.length; i += 200)
      must(await db.from('casino_lines').upsert(rows.slice(i, i + 200), { onConflict: 'id' }));
  },
  openLegs: async () => {
    const rows = must(await db.from('bet_legs')
      .select('bet_id,line_id,point,bets!inner(status),line:casino_lines!inner(id,season,week,event,sport,market,side,team,teams,player,commence_at,outcome)')
      .is('result', null).eq('bets.status', 'open')) ?? [];
    return rows as any[];
  },
  setOutcomes: async (p: unknown) => { must(await db.rpc('casino_set_outcomes', { p })); },
  games: async () => must(await db.from('casino_games')
    .select('event,sport,season,week,commence_at,state,detail,situation,possession,away,home,away_score,home_score,away_periods,home_periods')) ?? [],
  setGames: async (p: unknown) => { must(await db.rpc('casino_set_games', { p })); },
  setLive: async (p: unknown) => { must(await db.rpc('casino_set_live', { p })); },
  gradeLegs: async (p: unknown) => { must(await db.rpc('casino_grade_legs', { p })); },
  pendingBets: async () => {
    const bets = (must(await db.from('bets').select('id,placed_at,bet_legs(line_id,price,point,score_at)').eq('status', 'pending')) ?? []) as any[];
    const ids = [...new Set(bets.flatMap(b => b.bet_legs.map((l: any) => l.line_id)))];
    const lines = ids.length
      ? (must(await db.from('casino_lines').select('id,status,price,point,score,updated_at').in('id', ids)) ?? []) as any[]
      : [];
    const byId = Object.fromEntries(lines.map(l => [l.id, { ...l, price: Number(l.price), point: l.point == null ? null : Number(l.point) }]));
    return bets.map(b => ({
      bet: b,
      legs: b.bet_legs.map((l: any) => ({ ...l, price: Number(l.price), point: l.point == null ? null : Number(l.point) })),
      lines: byId,
    }));
  },
  resolve: async (id: number, accept: boolean, note: string | null) => {
    must(await db.rpc('casino_resolve', { p_bet: id, p_accept: accept, p_note: note }));
  },
  openBets: async () => {
    const bets = (must(await db.from('bets').select('id,kind,stake,bet_legs(line_id,price,result,event,group_price)').eq('status', 'open')) ?? []) as any[];
    return bets.map(b => ({ id: b.id, kind: b.kind, stake: Number(b.stake), legs: b.bet_legs.map((l: any) => ({
      line_id: l.line_id, event: l.event, price: Number(l.price), result: l.result,
      group_price: l.group_price == null ? null : Number(l.group_price) })) }));
  },
  settle: async (id: number, status: string, payout: number) => {
    must(await db.rpc('casino_settle', { p_bet: id, p_status: status, p_payout: payout }));
  },
};

Deno.serve(async req => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return new Response('forbidden', { status: 403 });
  try {
    const report = await runSync({ db: adapter, get, site: SITE });
    return Response.json(report);
  } catch (e) {
    console.error(e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
