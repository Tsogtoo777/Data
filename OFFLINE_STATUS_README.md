# Data Event Offline Status — staging-only implementation (2026-11-11)

## What changed
- Installable app shell via `sw.js`: caches the site and required CDN scripts for return visits. **Supabase API/auth requests are never cached.**
- IndexedDB saves user-scoped equipment/status/operator snapshots and a pending status queue.
- Status submission while offline saves a UUID and timestamp on the device, with an "unsent" indicator.
- On reconnect/focus and every 30 seconds while visible, the app attempts to replay pending statuses using a **server-side idempotent RPC**, reusing the existing `ets_status_actions_u5` action receipt and equipment-events audit trigger (no duplicate history table).
- Time of record is captured **when the user submits it**, not when the connection returns.
- Conflicts are held for manual review rather than overwriting other users' records.

## Deployment checklist — REQUIRED
1. Do not merge directly to main. Test on Vercel Preview first; verify app loads, login works, mobile layout and normal online status input work.
2. Back up Supabase. Review `sql/ets_offline_status_v1.sql` against the live schema, triggers, existing `ets_status_actions_u5` request IDs, RLS, and audit behavior. **Not automatically applied**. Prefer staging environment. The RPC runs as SECURITY DEFINER, checks role and timestamps, and uses the same table-wide lock as the existing online status writer. It uses the existing action/audit records instead of creating another table.
3. Open the *exact same preview URL* **online** on the phone and sign in. Tap **Offline бэлдэх**, wait for **Online · Offline бэлэн**, then disconnect. New Vercel preview deployment URLs are separate browser origins; their caches and IndexedDB queues are NOT shared.
4. Disable internet: refresh the EXACT SAME URL. Equipment/status must render from IndexedDB and show **Offline · Хадгалсан мэдээлэл**; then submit a test status (in staging only), verify pending count and original timestamp.
5. Restore internet: with the SQL installed in staging, check the UUID is replayed exactly once and `equipment_events.start_time` is the original capture time.
6. Simulate two devices submitting statuses for the same equipment; verify a conflict remains in the queue, with no auto-overwrite.
7. Simulate a timeout after server commit; retry same request UUID and confirm no duplicate.
8. Verify other user account does not see or send another user's pending items.

## Known limits
- Only equipment **status events** are supported. SMU, KM, production, operator reassignment, shift handover, and location updates are not auto-replayed.
- A status submitted with SMU/KM stays flagged for manual review, to preserve the meter ledger.
- Browser data deletion / incognito / uninstall / storage eviction can lose drafts. Offline drafts are **not** server backups.
- If the phone is fully closed, background sync is not guaranteed; open the app again to retry.
- The draft is not accepted in Supabase until a successful server response. The app labels it as pending until then.
- SQL/schema integration remains **untested** and production must not be changed until field tests pass.
- A previously queued item marked `setup-required` by an older immutable Vercel deployment will not retry in that old JavaScript build. **Do not delete its origin-local IndexedDB data**; plan a same-origin recovery before migrating to a new preview hostname.

## Status
- GitHub changes are on `feature/offline-status-queue-20261111`.
- Production unaffected. No live SQL execution performed.
