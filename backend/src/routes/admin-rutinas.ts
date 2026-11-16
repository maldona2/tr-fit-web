import { Router, type Request, type Response } from 'express';
import pool from '../db/connect.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/role.js';
import {
  adminListAthletesQuery,
  adminSlotCreatePayload,
  adminSlotPatchPayload,
  adminReorderPayload,
  adminTrainingDaysPayload,
  adminApplyEditsPayload,
  adminProgramWeekPayload,
} from '../domain/schemas.js';
import {
  listActiveAthletes,
  getActiveRutina,
  getPendingSkeletonId,
  createSlot,
  updateSlot,
  deleteSlot,
  reorderSlots,
  AdminRutinaError,
  changeTrainingDays,
  applyEdits,
  setProgramWeek,
} from '../services/admin-rutina.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string | undefined, res: Response): string | null {
  if (!value || !UUID_RE.test(value)) {
    res.status(400).json({ error: 'invalid_uuid' });
    return null;
  }
  return value;
}

const router = Router();
router.use(requireAuth, requireAdmin);

function mapError(err: unknown, res: Response): Response | void {
  if (err instanceof AdminRutinaError) {
    if (err.code === 'rutina_not_active') {
      return res.status(409).json({ error: 'rutina_not_active' });
    }
    if (err.code === 'regen_pending') {
      return res.status(409).json({ error: 'regen_pending' });
    }
    if (err.code === 'invalid_exercise') {
      return res.status(400).json({ error: 'invalid_exercise' });
    }
    if (err.code === 'invalid_payload') {
      return res.status(400).json({ error: 'invalid_payload' });
    }
    if (err.code === 'not_found') {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err.code === 'invalid_week') {
      return res.status(400).json({ error: 'invalid_week' });
    }
    if (err.code === 'session_in_progress') {
      return res.status(409).json({ error: 'session_in_progress' });
    }
  }
  throw err;
}

router.get('/atleta', async (req: Request, res: Response) => {
  const parsed = adminListAthletesQuery.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_query', issues: parsed.error.issues });
  }
  const r = await listActiveAthletes(parsed.data);
  res.json(r);
});

router.get('/atleta/:athleteId', async (req: Request, res: Response) => {
  const athleteId = requireUuid(req.params.athleteId, res);
  if (!athleteId) return;
  try {
    const r = await getActiveRutina(athleteId);
    if (r) return res.json({ rutina: r, pending_skeleton_id: null });
    const pending = await getPendingSkeletonId(athleteId);
    res.json({ rutina: null, pending_skeleton_id: pending });
  } catch (e) {
    mapError(e, res);
  }
});

router.post('/atleta/:athleteId/slots', async (req: Request, res: Response) => {
  const athleteId = requireUuid(req.params.athleteId, res);
  if (!athleteId) return;
  const parsed = adminSlotCreatePayload.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const slot = await createSlot(athleteId, parsed.data);
    res.status(201).json({ slot });
  } catch (e) {
    mapError(e, res);
  }
});

async function actorEmail(req: Request): Promise<string> {
  if (!req.user) return 'system';
  const r = await pool.query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`,
    [req.user.id]
  );
  return r.rows[0]?.email ?? `admin:${req.user.id.slice(0, 8)}`;
}

router.post(
  '/atleta/:athleteId/program-week',
  async (req: Request, res: Response) => {
    const athleteId = requireUuid(req.params.athleteId, res);
    if (!athleteId) return;
    const parsed = adminProgramWeekPayload.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    try {
      const state = await setProgramWeek(
        athleteId,
        parsed.data.week,
        await actorEmail(req)
      );
      res.json(state);
    } catch (error) {
      mapError(error, res);
    }
  }
);

router.post(
  '/atleta/:athleteId/training-days',
  async (req: Request, res: Response) => {
    const athleteId = requireUuid(req.params.athleteId, res);
    if (!athleteId) return;
    const parsed = adminTrainingDaysPayload.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'invalid_payload', issues: parsed.error.issues });
    try {
      await changeTrainingDays(athleteId, parsed.data);
      res.status(202).json({ status: 'queued' });
    } catch (error) {
      mapError(error, res);
    }
  }
);

router.post(
  '/atleta/:athleteId/reorder',
  async (req: Request, res: Response) => {
    const athleteId = requireUuid(req.params.athleteId, res);
    if (!athleteId) return;
    const parsed = adminReorderPayload.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    try {
      await reorderSlots(athleteId, parsed.data);
      res.status(204).end();
    } catch (e) {
      mapError(e, res);
    }
  }
);

router.post(
  '/atleta/:athleteId/apply-edits',
  async (req: Request, res: Response) => {
    const athleteId = requireUuid(req.params.athleteId, res);
    if (!athleteId) return;
    const parsed = adminApplyEditsPayload.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    try {
      await applyEdits(athleteId, parsed.data);
      res.status(204).end();
    } catch (e) {
      mapError(e, res);
    }
  }
);

router.patch('/slots/:slotId', async (req: Request, res: Response) => {
  const slotId = requireUuid(req.params.slotId, res);
  if (!slotId) return;
  const parsed = adminSlotPatchPayload.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_payload', issues: parsed.error.issues });
  }
  try {
    const slot = await updateSlot(slotId, parsed.data);
    res.json({ slot });
  } catch (e) {
    mapError(e, res);
  }
});

router.delete('/slots/:slotId', async (req: Request, res: Response) => {
  const slotId = requireUuid(req.params.slotId, res);
  if (!slotId) return;
  try {
    await deleteSlot(slotId);
    res.status(204).end();
  } catch (e) {
    mapError(e, res);
  }
});

export default router;
