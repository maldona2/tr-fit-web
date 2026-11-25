import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AxiosError } from 'axios';
import { Library, Pencil, RotateCcw } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  useApplyRoutineTemplate,
  useApproveRutina,
  useDiscardRutina,
  useRejectRutina,
  useRutina,
} from '@/hooks/useRutina';
import { useRutinasHotkeys } from '@/hooks/useRutinasHotkeys';
import { DetailHeader } from './DetailHeader';
import { RationaleCard } from './RationaleCard';
import { TabRutina } from './TabRutina';
import type { AddedSlotData } from './AddSlotPopover';
import { TabContexto } from './TabContexto';
import { TabHistorial } from './TabHistorial';
import { TabDiff } from './TabDiff';
import { ActionFooter } from './ActionFooter';
import { DiscardDialog } from './DiscardDialog';
import { RejectDialog, type RejectPayload } from './RejectDialog';
import { ShortcutsModal } from './ShortcutsModal';
import { TemplatePickerDialog } from './TemplatePickerDialog';
import type { SlotOverride } from './EditSlotPopover';
import type { RutinaSlot } from '@/types/api';
import {
  clearRoutineDraft,
  loadRoutineDraft,
  saveRoutineDraft,
} from './routine-draft';

type TabKey = 'rutina' | 'contexto' | 'historial' | 'diff';

export function DetailPane({
  id,
  onSkip,
  onAdvance,
  onNext,
  onPrev,
}: {
  id: string;
  onSkip: () => void;
  onAdvance: () => void;
  onNext: () => void;
  onPrev: () => void;
}) {
  const { data, isLoading, error } = useRutina(id);
  const approve = useApproveRutina();
  const reject = useRejectRutina();
  const discard = useDiscardRutina();
  const applyTemplate = useApplyRoutineTemplate();
  const [templateOpen, setTemplateOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('rutina');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, SlotOverride>>({});
  // Local reordering of slots; null = use server order untouched.
  const [order, setOrder] = useState<RutinaSlot[] | null>(null);
  // Slots the admin removed locally before approving.
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  // Ids of brand-new slots the admin added locally (their data lives in `order`).
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  useEffect(() => {
    setTab('rutina');
    setRejectOpen(false);
    setDiscardOpen(false);
    setTemplateOpen(false);
    const draft = loadRoutineDraft(id);
    setOverrides(draft?.overrides ?? {});
    setOrder(draft?.order ?? null);
    setDeleted(new Set(draft?.deletedIds ?? []));
    setAddedIds(new Set(draft?.addedIds ?? []));
  }, [id]);

  const hasDraftChanges =
    Object.keys(overrides).length > 0 ||
    order !== null ||
    deleted.size > 0 ||
    addedIds.size > 0;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!hasDraftChanges) {
        clearRoutineDraft(id);
        return;
      }
      saveRoutineDraft(id, {
        version: 1,
        overrides,
        order,
        deletedIds: [...deleted],
        addedIds: [...addedIds],
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [id, hasDraftChanges, overrides, order, deleted, addedIds]);

  function resetDraft() {
    clearRoutineDraft(id);
    setOverrides({});
    setOrder(null);
    setDeleted(new Set());
    setAddedIds(new Set());
    toast.success('Borrador reiniciado');
  }

  const orderedSlots = useMemo(
    () =>
      (
        order ??
        [...(data?.slots ?? [])].sort(
          (a, b) => a.day_of_week - b.day_of_week || a.slot_index - b.slot_index
        )
      ).filter((s) => !deleted.has(s.id)),
    [order, data, deleted]
  );

  function handleDragEnd(e: DragEndEvent) {
    if (!e.over) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    if (activeId === overId) return;

    const sorted = [...orderedSlots];
    const movingIndex = sorted.findIndex((s) => s.id === activeId);
    const targetIndex = sorted.findIndex((s) => s.id === overId);
    if (movingIndex < 0 || targetIndex < 0) return;
    const targetDay = sorted[targetIndex].day_of_week;

    const moved = {
      ...sorted.splice(movingIndex, 1)[0],
      day_of_week: targetDay,
    };
    const insertAt = sorted.findIndex((s) => s.id === overId);
    sorted.splice(insertAt, 0, moved);

    // Validate no day exceeds 12 slots (DB CHECK constraint).
    const counts = new Map<number, number>();
    for (const s of sorted) {
      counts.set(s.day_of_week, (counts.get(s.day_of_week) ?? 0) + 1);
    }
    if ([...counts.values()].some((n) => n > 12)) {
      toast.error('Un día no puede tener más de 12 ejercicios');
      return;
    }
    setOrder(sorted);
  }

  const modalOpen =
    rejectOpen || discardOpen || shortcutsOpen || templateOpen;

  useRutinasHotkeys(
    {
      onApprove: () => {
        if (modalOpen || approve.isPending || reject.isPending) return;
        void onApprove();
      },
      onReject: () => {
        if (modalOpen) return;
        setRejectOpen(true);
      },
      onNext: () => {
        if (modalOpen) return;
        onNext();
      },
      onPrev: () => {
        if (modalOpen) return;
        onPrev();
      },
      onTab: (idx) => {
        if (modalOpen) return;
        const map: Record<number, TabKey> = {
          1: 'rutina',
          2: 'contexto',
          3: 'historial',
          4: 'diff',
        };
        setTab(map[idx]);
      },
      onShortcuts: () => {
        if (modalOpen) return;
        setShortcutsOpen(true);
      },
      onEsc: () => {
        if (rejectOpen) setRejectOpen(false);
        else if (discardOpen) setDiscardOpen(false);
        else if (shortcutsOpen) setShortcutsOpen(false);
        else if (templateOpen) setTemplateOpen(false);
      },
    },
    { enabled: !!data }
  );

  async function onApprove() {
    try {
      const deleted_slot_ids = [...deleted];
      // Brand-new slots (data lives in `order`); server assigns the final index.
      const added_slots = (order ?? [])
        .filter((s) => addedIds.has(s.id) && !deleted.has(s.id))
        .map((s) => ({
          id: s.id,
          day_of_week: s.day_of_week,
          exercise_id: s.exercise_id,
          role: s.role,
          notes: s.notes ?? undefined,
          series: s.series ?? null,
          reps: s.reps ?? null,
          descanso: s.descanso ?? null,
        }));
      const slot_overrides = Object.entries(overrides)
        // A deleted slot's pending edits are irrelevant.
        .filter(([slot_id]) => !deleted.has(slot_id))
        .map(([slot_id, ov]) => ({
          slot_id,
          exercise_id: ov.exercise_id,
          notes: ov.notes,
          ...('series' in ov
            ? { series: ov.series, reps: ov.reps, descanso: ov.descanso }
            : {}),
        }));
      // Reindex 1..N per day, preserving local order and skipping deleted slots.
      const perDay = new Map<number, number>();
      const slot_order = order
        ? order
            .filter((s) => !deleted.has(s.id))
            .map((s) => {
              const idx = (perDay.get(s.day_of_week) ?? 0) + 1;
              perDay.set(s.day_of_week, idx);
              return {
                slot_id: s.id,
                day_of_week: s.day_of_week,
                slot_index: idx,
              };
            })
        : undefined;
      await approve.mutateAsync({
        id,
        slot_overrides,
        slot_order,
        deleted_slot_ids,
        added_slots,
      });
      clearRoutineDraft(id);
      toast.success('Rutina aprobada · pasando a la siguiente');
      onAdvance();
    } catch (e) {
      const err = e as AxiosError<{ error?: string }>;
      if (err.response?.status === 409) {
        toast.info('Ya fue procesada · pasando a la siguiente');
        onAdvance();
      } else {
        toast.error('No se pudo aprobar · intentá de nuevo');
      }
    }
  }

  async function onDiscard() {
    try {
      await discard.mutateAsync(id);
      setDiscardOpen(false);
      clearRoutineDraft(id);
      toast.success('Rutina descartada');
      onAdvance();
    } catch (e) {
      const err = e as AxiosError<{ error?: string }>;
      if (err.response?.status === 409) {
        setDiscardOpen(false);
        toast.info('Ya fue procesada · pasando a la siguiente');
        onAdvance();
      } else {
        toast.error('No se pudo descartar · intentá de nuevo');
      }
    }
  }

  async function onReject(payload: RejectPayload) {
    try {
      await reject.mutateAsync({ id, feedback: payload.feedback });
      setRejectOpen(false);
      toast.info(
        payload.critical
          ? 'Regenerando rutina (prioritaria) · ~30s'
          : 'Regenerando rutina · ~30s'
      );
      onAdvance();
    } catch {
      toast.error('No se pudo rechazar');
    }
  }

  async function onApplyTemplate(source: string) {
    try {
      await applyTemplate.mutateAsync({ id, source });
      // Slot ids changed server-side; the local draft no longer applies.
      clearRoutineDraft(id);
      setOverrides({});
      setOrder(null);
      setDeleted(new Set());
      setAddedIds(new Set());
      setTemplateOpen(false);
      toast.success('Rutina reemplazada');
    } catch (e) {
      const err = e as AxiosError<{ error?: string }>;
      if (err.response?.status === 409) {
        setTemplateOpen(false);
        toast.info('Ya fue procesada · pasando a la siguiente');
        onAdvance();
      } else {
        toast.error('No se pudo cambiar la rutina');
      }
    }
  }

  function setOverride(slotId: string, payload: SlotOverride) {
    // Added slots only exist locally (in `order`); fold edits into the slot
    // itself rather than the server-override map.
    if (addedIds.has(slotId)) {
      const hasScheme = 'series' in payload;
      setOrder((list) =>
        (list ?? []).map((s) =>
          s.id === slotId
            ? {
                ...s,
                exercise_id: payload.exercise_id,
                exercise_name: payload.exercise_name,
                muscle_group: payload.muscle_group,
                notes: payload.notes ?? null,
                ...(hasScheme
                  ? {
                      series: payload.series ?? null,
                      reps: payload.reps ?? null,
                      descanso: payload.descanso ?? null,
                    }
                  : {}),
              }
            : s
        )
      );
      toast.success('Slot actualizado · cambios locales');
      return;
    }
    setOverrides((m) => ({ ...m, [slotId]: payload }));
    toast.success('Slot actualizado · cambios locales');
  }

  function deleteSlot(slotId: string) {
    // Removing a locally-added slot just drops it; it never hit the server.
    if (addedIds.has(slotId)) {
      setOrder((list) => (list ?? []).filter((s) => s.id !== slotId));
      setAddedIds((s) => {
        const next = new Set(s);
        next.delete(slotId);
        return next;
      });
      toast.success('Ejercicio eliminado · cambios locales');
      return;
    }
    setDeleted((d) => new Set(d).add(slotId));
    setOverrides((m) => {
      const next = { ...m };
      delete next[slotId];
      return next;
    });
    toast.success('Ejercicio eliminado · cambios locales');
  }

  function addSlot(day: number, data: AddedSlotData) {
    const dayCount = orderedSlots.filter((s) => s.day_of_week === day).length;
    if (dayCount >= 12) {
      toast.error('Un día no puede tener más de 12 ejercicios');
      return;
    }
    const newSlot: RutinaSlot = {
      id: crypto.randomUUID(),
      day_of_week: day,
      slot_index: 0, // reindexed server-side on approve
      exercise_id: data.exercise_id,
      role: data.role,
      notes: data.notes ?? null,
      series: data.series ?? null,
      reps: data.reps ?? null,
      descanso: data.descanso ?? null,
      exercise_name: data.exercise_name,
      muscle_group: data.muscle_group,
    };
    // Seed `order` from the current view so the new slot has an explicit place.
    setOrder([...orderedSlots, newSlot]);
    setAddedIds((s) => new Set(s).add(newSlot.id));
    toast.success('Ejercicio agregado · cambios locales');
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-7 py-5">
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-5 w-48 animate-pulse rounded bg-muted" />
        </div>
        <div className="flex-1 space-y-4 px-7 py-6">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-md border border-border bg-muted/30"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center px-7">
        <div className="rounded-md border border-border bg-card p-6 text-center">
          <p className="text-[13px] text-destructive">Error cargando rutina.</p>
        </div>
      </div>
    );
  }

  const modCount = Object.keys(overrides).length;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <DetailHeader data={data} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-7">
        {hasDraftChanges && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-400">
            <Pencil size={12} />
            Modificada por admin
            {modCount > 0 &&
              ` · ${modCount} cambio${modCount === 1 ? '' : 's'}`}
            {addedIds.size > 0 &&
              ` · ${addedIds.size} agregado${addedIds.size === 1 ? '' : 's'}`}
            {deleted.size > 0 &&
              ` · ${deleted.size} eliminado${deleted.size === 1 ? '' : 's'}`}
            {order !== null && ' · orden reordenado'}
            <button
              type="button"
              onClick={resetDraft}
              className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 hover:bg-amber-500/15"
            >
              <RotateCcw size={12} /> Reiniciar
            </button>
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <div className="flex flex-wrap items-center gap-2">
            <TabsList>
              <TabsTrigger value="rutina">Rutina</TabsTrigger>
              <TabsTrigger value="contexto">Contexto</TabsTrigger>
              <TabsTrigger value="historial">Historial</TabsTrigger>
              <TabsTrigger value="diff">Diff</TabsTrigger>
            </TabsList>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setTemplateOpen(true)}
            >
              <Library size={14} className="mr-1.5" />
              Elegir rutina
            </Button>
          </div>
          <div className="mt-5">
            <TabsContent value="rutina">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <TabRutina
                  slots={orderedSlots}
                  daysSpecific={data.profile.days_specific}
                  periodization={data.periodization}
                  overrides={overrides}
                  onOverride={setOverride}
                  onDelete={deleteSlot}
                  onAdd={addSlot}
                />
              </DndContext>
            </TabsContent>
            <TabsContent value="contexto">
              <TabContexto profile={data.profile} />
            </TabsContent>
            <TabsContent value="historial">
              <TabHistorial />
            </TabsContent>
            <TabsContent value="diff">
              <TabDiff />
            </TabsContent>
          </div>
        </Tabs>

        <div className="mt-5">
          <RationaleCard rationale={data.skeleton.generation_rationale} />
        </div>
      </div>

      <ActionFooter
        onApprove={onApprove}
        onReject={() => setRejectOpen(true)}
        onDiscard={() => setDiscardOpen(true)}
        onSkip={onSkip}
        approving={approve.isPending}
        rejecting={reject.isPending}
        discarding={discard.isPending}
      />

      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        athleteName={data.profile.name}
        onSubmit={onReject}
        submitting={reject.isPending}
      />

      <DiscardDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        athleteName={data.profile.name}
        onConfirm={onDiscard}
        submitting={discard.isPending}
      />

      <TemplatePickerDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        profile={data.profile}
        current={data.skeleton.generation_prompt?.template}
        onConfirm={onApplyTemplate}
        submitting={applyTemplate.isPending}
      />

      <ShortcutsModal open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
